import type { Firestore } from "firebase-admin/firestore";
import type { CollectionName } from "./collections.js";
import { toPlain } from "./firestore-reader.js";
import { readAll } from "./read-all.js";
import type { RawDoc, SourceReader } from "./types.js";

/** Point reads and simple queries on the source, for the API's Firestore read path. */
export type DocumentStore = {
  get(collection: CollectionName, id: string): Promise<RawDoc | undefined>;
  findBy(collection: CollectionName, field: string, value: string): Promise<RawDoc[]>;
  all(collection: CollectionName): Promise<RawDoc[]>;
};

export function firestoreDocumentStore(db: Firestore): DocumentStore {
  return {
    get: async (collection, id) => {
      const snapshot = await db.collection(collection).doc(id).get();
      const data = snapshot.data();
      if (!snapshot.exists || !data || !snapshot.updateTime) return undefined;
      return { id, updateTime: snapshot.updateTime.toDate(), data: toPlain(data) };
    },
    findBy: async (collection, field, value) => {
      const snapshot = await db.collection(collection).where(field, "==", value).get();
      return snapshot.docs.map((doc) => ({
        id: doc.id,
        updateTime: doc.updateTime.toDate(),
        data: toPlain(doc.data()),
      }));
    },
    all: async (collection) => {
      const snapshot = await db.collection(collection).get();
      return snapshot.docs.map((doc) => ({
        id: doc.id,
        updateTime: doc.updateTime.toDate(),
        data: toPlain(doc.data()),
      }));
    },
  };
}

/** The same interface over a SourceReader (the JSON export in tests), loaded once. */
export function readerDocumentStore(reader: SourceReader): DocumentStore {
  const cache = new Map<CollectionName, Promise<RawDoc[]>>();
  const all = (collection: CollectionName) => {
    const docs = cache.get(collection) ?? readAll(reader, collection);
    cache.set(collection, docs);
    return docs;
  };
  return {
    get: async (collection, id) => (await all(collection)).find((doc) => doc.id === id),
    findBy: async (collection, field, value) =>
      (await all(collection)).filter((doc) => doc.data[field] === value),
    all,
  };
}
