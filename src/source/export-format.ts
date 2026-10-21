import { z } from "zod";
import type { CollectionName } from "./collections.js";

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
