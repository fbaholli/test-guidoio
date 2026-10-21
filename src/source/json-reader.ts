import { readFile } from "node:fs/promises";
import { compareCodeUnits } from "../util/order.js";
import { COLLECTIONS, type CollectionName } from "./collections.js";
import { decodeExportDoc, exportFileSchema } from "./export-format.js";
import type { RawDoc, SourceReader } from "./types.js";

/** Reads test/fixtures/export.json through the same interface as Firestore. */
export async function createJsonReader(path: string): Promise<SourceReader> {
  const file = exportFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const docs = new Map<CollectionName, RawDoc[]>(
    COLLECTIONS.map((name) => [
      name,
      file.collections[name].map(decodeExportDoc).sort((a, b) => compareCodeUnits(a.id, b.id)),
    ]),
  );

  return {
    name: "json",
    readPage: async (collection, afterId, limit) => {
      const all = docs.get(collection) ?? [];
      const start =
        afterId === undefined ? 0 : all.findIndex((doc) => compareCodeUnits(doc.id, afterId) > 0);
      return start === -1 ? [] : all.slice(start, start + limit);
    },
    close: async () => {},
  };
}
