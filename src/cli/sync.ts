import { z } from "zod";
import { createPool } from "../db/pool.js";
import {
  type SyncEvent,
  startSyncSession,
  stopSyncSession,
  syncDocument,
} from "../migrate/sync.js";
import { ROME_TIME_ZONE } from "../normalize/context.js";
import { connectFirestore } from "../source/firestore-client.js";
import { assertEmulatorRunning } from "../source/firestore-emulator.js";
import { listenToFirestore } from "../source/firestore-listener.js";
import { parseCliArgs } from "./parse-args.js";
import { runCli } from "./run-cli.js";

const argsSchema = z.object({ source: z.enum(["emulator", "firestore"]).default("emulator") });

await runCli("sync", async ({ config, logger }) => {
  const args = parseCliArgs(process.argv.slice(2), { source: { type: "string" } }, argsSchema);
  const connection = connectFirestore(config.firestore, args.source);
  if (args.source === "emulator" && config.firestore.emulatorHost) {
    await assertEmulatorRunning(config.firestore.emulatorHost);
  }
  const pool = createPool(config.db.url, logger);
  const session = await startSyncSession(pool, {
    source: args.source,
    timeZone: ROME_TIME_ZONE,
    logger,
  });

  // One change at a time, in arrival order: a queue of promises.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (event: SyncEvent) => {
    queue = queue.then(async () => {
      const started = Date.now();
      try {
        const outcome = await syncDocument(pool, session, event);
        logger.info(
          { collection: event.collection, ...outcome, ms: Date.now() - started },
          "synced",
        );
      } catch (error) {
        logger.error({ err: error, collection: event.collection }, "sync failed for one change");
      }
    });
  };

  const stopListening = listenToFirestore(
    connection.db,
    {
      onInitial: (collection, docs) => {
        if (collection === "students") for (const doc of docs) session.students.set(doc.id, doc);
        logger.info({ collection, docs: docs.length }, "listening");
      },
      onEvent: enqueue,
    },
    logger,
  );

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  stopListening();
  await queue;
  await stopSyncSession(pool, session);
  await connection.close();
  await pool.end();
  logger.info({ runId: session.runId, stats: session.stats }, "sync stopped");
});
