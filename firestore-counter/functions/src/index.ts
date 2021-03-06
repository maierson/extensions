/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { PubSub } from "@google-cloud/pubsub";
import { ShardedCounterWorker } from "./worker";
import { ShardedCounterController, ControllerStatus } from "./controller";

admin.initializeApp();
const firestore = admin.firestore();
firestore.settings({ timestampsInSnapshots: true });

let pubsub;

const SHARDS_COLLECTION_ID = "_counter_shards_";
const WORKERS_COLLECTION_ID = "_counter_workers_";

/**
 * The controllerCore is scheduled every minute. It tries to aggregate shards if
 * there's less than 200 of them. Otherwise it is scheduling and monitoring
 * workers to do the aggregation.
 */
export const controllerCore = functions.handler.pubsub.topic.onPublish(
  async () => {
    const metadocRef = firestore.doc(process.env.INTERNAL_STATE_PATH);
    const controller = new ShardedCounterController(
      metadocRef,
      SHARDS_COLLECTION_ID
    );
    let status = await controller.aggregateOnce({ start: "", end: "" }, 200);
    if (
      status === ControllerStatus.WORKERS_RUNNING ||
      status === ControllerStatus.TOO_MANY_SHARDS ||
      status === ControllerStatus.FAILURE
    ) {
      await controller.rescheduleWorkers();
    }
    return null;
  }
);

/**
 * Backwards compatible HTTPS function
 */
export const controller = functions.https.onRequest(async (req, res) => {
  if (!pubsub) {
    pubsub = new PubSub();
  }
  await pubsub
    .topic(process.env.EXT_INSTANCE_ID)
    .publish(Buffer.from(JSON.stringify({})));
  res.status(200).send("Ok");
});

/**
 * Worker is responsible for aggregation of a defined range of shards. It is controlled
 * by a worker metadata document. At the end of its run (that lasts for 45s) it writes
 * back stats that kicks off another run at the same time.
 *
 * ControllerCore is monitoring these metadata documents to detect overload that requires
 * resharding and to detect failed workers that need poking.
 */
export const worker = functions.firestore
  .document(
    process.env.INTERNAL_STATE_PATH + WORKERS_COLLECTION_ID + "/{workerId}"
  )
  .onWrite(async (change, context) => {
    // stop worker if document got deleted
    if (!change.after.exists) return;

    const worker = new ShardedCounterWorker(change.after, SHARDS_COLLECTION_ID);
    await worker.run();
  });

/**
 * This is an additional function that is triggered for every shard write. It is
 * limited to one concurrent run at the time. This helps reduce latency for workloads
 * that are below the threshold for workers.
 */
export const onWrite = functions.firestore
  .document("/{collection}/{**}/_counter_shards_/{shardId}")
  .onWrite(async (change, context) => {
    const metadocRef = firestore.doc(process.env.INTERNAL_STATE_PATH);
    const controller = new ShardedCounterController(
      metadocRef,
      SHARDS_COLLECTION_ID
    );
    await controller.aggregateContinuously({ start: "", end: "" }, 200, 60000);
  });
