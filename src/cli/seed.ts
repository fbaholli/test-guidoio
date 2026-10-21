import { relative } from "node:path";
import { parseSeedArgs } from "../seed/args.js";
import { buildSeedDataset, EXPORT_UPDATE_TIME } from "../seed/dataset.js";
import { assertCollectionsEmpty, writeDataset } from "../seed/firestore-writer.js";
import { DEFAULT_EXPORT_PATH, toExportJson, writeExportFile } from "../seed/json-export.js";
import type { SeedDataset } from "../seed/types.js";
import { COLLECTIONS } from "../source/collections.js";
import { connectFirestore } from "../source/firestore-client.js";
import { assertEmulatorRunning, clearEmulator } from "../source/firestore-emulator.js";
import { runCli } from "./run-cli.js";

await runCli("seed", async ({ config, logger }) => {
  const args = parseSeedArgs(process.argv.slice(2));
  const dataset = buildSeedDataset();

  if (args.target === "json") {
    const path = args.out ?? DEFAULT_EXPORT_PATH;
    await writeExportFile(path, toExportJson(dataset, EXPORT_UPDATE_TIME));
    logger.info({ path: relative(process.cwd(), path), ...countDocs(dataset) }, "export written");
    return;
  }

  // Validates the target before anything is touched: emulator needs FIRESTORE_EMULATOR_HOST,
  // a real project needs credentials and no emulator variable.
  const connection = connectFirestore(config.firestore, args.target);
  try {
    const { emulatorHost, projectId } = config.firestore;
    if (args.target === "emulator" && emulatorHost) {
      await assertEmulatorRunning(emulatorHost);
      // A fresh emulator every time, so the result never depends on an earlier run.
      await clearEmulator(emulatorHost, projectId);
    }
    if (args.target === "firestore") await assertCollectionsEmpty(connection.db);

    await writeDataset(connection.db, dataset, logger);
    logger.info({ target: args.target, projectId, ...countDocs(dataset) }, "seed written");
  } finally {
    await connection.close();
  }
});

function countDocs(dataset: SeedDataset): Record<string, number> {
  return Object.fromEntries(COLLECTIONS.map((name) => [name, dataset[name].length]));
}
