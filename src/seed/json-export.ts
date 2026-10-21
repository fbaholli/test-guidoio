import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CollectionName } from "../source/collections.js";
import { type ExportDoc, type ExportFile, TIMESTAMP_KEY } from "../source/export-format.js";
import {
  isSeedList,
  type SeedDataset,
  type SeedFields,
  SeedTimestamp,
  type SeedValue,
} from "./types.js";

export const DEFAULT_EXPORT_PATH = fileURLToPath(
  new URL("../../test/fixtures/export.json", import.meta.url),
);

/** The dataset as the JSON export, byte-for-byte the same on every run. */
export function toExportJson(dataset: SeedDataset, updateTime: string): string {
  const docsOf = (name: CollectionName): ExportDoc[] =>
    dataset[name].map((doc) => ({
      id: doc.id,
      _updateTime: updateTime,
      data: encodeFields(doc.fields),
    }));
  const file: ExportFile = {
    collections: {
      cities: docsOf("cities"),
      pickupPoints: docsOf("pickupPoints"),
      instructors: docsOf("instructors"),
      students: docsOf("students"),
      bookings: docsOf("bookings"),
    },
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export async function writeExportFile(path: string, json: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json, "utf8");
}

function encodeFields(fields: SeedFields): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [field, encodeValue(value)]),
  );
}

function encodeValue(value: SeedValue): unknown {
  if (value instanceof SeedTimestamp) return { [TIMESTAMP_KEY]: value.iso };
  if (isSeedList(value)) return value.map(encodeValue);
  if (value !== null && typeof value === "object") return encodeFields(value);
  return value;
}
