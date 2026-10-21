import { z } from "zod";
import type { CollectionName } from "./collections.js";
import type { RawDoc } from "./types.js";

// test/fixtures/export.json is a stand-in for Firestore, so it must carry everything a
// Firestore read returns: the document id, its update time, and typed values. JSON has no
// timestamp type, so Firestore Timestamps are wrapped as { "$timestamp": "<ISO UTC>" }.

export const TIMESTAMP_KEY = "$timestamp";

export const exportDocSchema = z.object({
  id: z.string().min(1),
  _updateTime: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});

export const exportFileSchema = z.object({
  collections: z.object({
    cities: z.array(exportDocSchema),
    pickupPoints: z.array(exportDocSchema),
    instructors: z.array(exportDocSchema),
    students: z.array(exportDocSchema),
    bookings: z.array(exportDocSchema),
  } satisfies Record<CollectionName, z.ZodType>),
});

export type ExportDoc = z.infer<typeof exportDocSchema>;
export type ExportFile = z.infer<typeof exportFileSchema>;

/** Back to what a Firestore read returns: wrapped timestamps become Dates again. */
export function decodeExportDoc(doc: ExportDoc): RawDoc {
  return { id: doc.id, updateTime: new Date(doc._updateTime), data: decodeFields(doc.data) };
}

function decodeFields(fields: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [field, decodeValue(value)]),
  );
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value);
  const [only] = entries;
  if (entries.length === 1 && only?.[0] === TIMESTAMP_KEY && typeof only[1] === "string") {
    return new Date(only[1]);
  }
  return decodeFields(value);
}
