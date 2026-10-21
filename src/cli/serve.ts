import { buildApp } from "../api/app.js";
import { firestoreBookings } from "../api/repos/firestore.js";
import { postgresBookings } from "../api/repos/postgres.js";
import { emptyShadowStats, shadowBookings } from "../api/repos/shadow.js";
import { createDb } from "../db/kysely.js";
import { createPool } from "../db/pool.js";
import { ROME_TIME_ZONE } from "../normalize/context.js";
import { firestoreDocumentStore } from "../source/document-store.js";
import { connectFirestore } from "../source/firestore-client.js";
import { runCli } from "./run-cli.js";

await runCli("serve", async ({ config, logger }) => {
  const db = createDb(createPool(config.db.url, logger));
  const postgres = postgresBookings(db);

  // The Firestore read path exists only when there's a Firestore to read: the emulator
  // locally, or a real project with credentials.
  const { emulatorHost, credentialsPath } = config.firestore;
  const connection =
    emulatorHost || credentialsPath
      ? connectFirestore(config.firestore, emulatorHost ? "emulator" : "firestore")
      : undefined;
  const firestore =
    connection && firestoreBookings(firestoreDocumentStore(connection.db), ROME_TIME_ZONE);
  const shadowStats = emptyShadowStats();

  const app = await buildApp({
    logger,
    shadowStats,
    readSource: config.api.bookingsReadSource,
    allowHeaderOverride: config.nodeEnv !== "production",
    readers: {
      postgres,
      ...(firestore
        ? { firestore, shadow: shadowBookings(firestore, postgres, logger, shadowStats) }
        : {}),
    },
    writer: postgres,
  });
  await app.listen({ host: config.api.host, port: config.api.port });

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await app.close();
  await connection?.close();
  await db.destroy();
});
