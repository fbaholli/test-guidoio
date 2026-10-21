import { FieldPath, type Firestore, Timestamp } from "firebase-admin/firestore";
import type { RawDoc, SourceReader } from "./types.js";

/**
 * Pages through a collection by document id: `startAfter(lastId)` is a stable cursor, so a
 * resumed run continues exactly where the last committed batch ended.
 */
export function createFirestoreReader(
  db: Firestore,
  name: "emulator" | "firestore",
  close: () => Promise<void>,
): SourceReader {
  return {
    name,
    readPage: async (collection, afterId, limit) => {
      let query = db.collection(collection).orderBy(FieldPath.documentId()).limit(limit);
      if (afterId !== undefined) query = query.startAfter(afterId);
      const snapshot = await query.get();
      return snapshot.docs.map(
        (doc): RawDoc => ({
          id: doc.id,
          updateTime: doc.updateTime.toDate(),
          data: toPlain(doc.data()),
        }),
      );
    },
    close,
  };
}

/** Timestamps become Dates, the same as the JSON reader produces; everything else stays as is. */
export function toPlain(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [field, plainValue(value)]),
  );
}

function plainValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate();
  if (Array.isArray(value)) return value.map(plainValue);
  if (value !== null && typeof value === "object" && value.constructor === Object) {
    return toPlain(value as Record<string, unknown>);
  }
  return value;
}
