import type { Config } from "../config.js";
import { DEFAULT_EXPORT_PATH } from "../seed/json-export.js";
import { connectFirestore } from "./firestore-client.js";
import { assertEmulatorRunning } from "./firestore-emulator.js";
import { createFirestoreReader } from "./firestore-reader.js";
import { createJsonReader } from "./json-reader.js";
import type { SourceReader } from "./types.js";

export type SourceName = SourceReader["name"];

export async function openSourceReader(
  source: SourceName,
  config: Config,
  jsonPath = DEFAULT_EXPORT_PATH,
): Promise<SourceReader> {
  if (source === "json") return createJsonReader(jsonPath);

  const connection = connectFirestore(config.firestore, source);
  if (source === "emulator" && config.firestore.emulatorHost) {
    await assertEmulatorRunning(config.firestore.emulatorHost);
  }
  return createFirestoreReader(connection.db, source, connection.close);
}
