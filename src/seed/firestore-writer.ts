import { type Firestore, Timestamp } from "firebase-admin/firestore";
import type { Logger } from "pino";
import { COLLECTIONS, type CollectionName } from "../source/collections.js";
import {
  isSeedList,
  type SeedDataset,
  type SeedFields,
  SeedTimestamp,
  type SeedValue,
} from "./types.js";

/** Firestore's limit on writes in one batch. */
export const MAX_BATCH_WRITES = 500;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

export function toFirestoreFields(fields: SeedFields): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [field, toFirestoreValue(value)]),
  );
}

function toFirestoreValue(value: SeedValue): unknown {
  if (value instanceof SeedTimestamp) return Timestamp.fromDate(new Date(value.iso));
  if (isSeedList(value)) return value.map(toFirestoreValue);
  if (value !== null && typeof value === "object") return toFirestoreFields(value);
  return value;
}

export type WrittenCollection = { collection: CollectionName; docs: number };

/** Writes every collection in foreign-key order, at most 500 writes per batch. */
export async function writeDataset(
  db: Firestore,
  dataset: SeedDataset,
  logger: Logger,
): Promise<WrittenCollection[]> {
  const written: WrittenCollection[] = [];
  for (const collection of COLLECTIONS) {
    const docs = dataset[collection];
    for (const part of chunk(docs, MAX_BATCH_WRITES)) {
      const batch = db.batch();
      for (const doc of part) {
        batch.set(db.collection(collection).doc(doc.id), toFirestoreFields(doc.fields));
      }
      await batch.commit();
    }
    written.push({ collection, docs: docs.length });
    logger.info({ collection, docs: docs.length }, "collection written");
  }
  return written;
}

/** Real-project safety: refuse to mix fake data into collections that already hold documents. */
export async function assertCollectionsEmpty(db: Firestore): Promise<void> {
  for (const collection of COLLECTIONS) {
    const snapshot = await db.collection(collection).limit(1).get();
    if (!snapshot.empty) {
      throw new Error(`Collection ${collection} is not empty; refusing to seed a real project`);
    }
  }
}
