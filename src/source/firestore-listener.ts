import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { Logger } from "pino";
import type { SyncEvent } from "../migrate/sync.js";
import { COLLECTIONS, type CollectionName } from "./collections.js";
import { toPlain } from "./firestore-reader.js";
import type { RawDoc } from "./types.js";

export type ListenerHandlers = {
  /** The first snapshot of each collection: the state when listening began. */
  onInitial: (collection: CollectionName, docs: RawDoc[]) => void;
  /** Every change after that, in the order Firestore reports it. */
  onEvent: (event: SyncEvent) => void;
};

/**
 * onSnapshot on every collection; locally this stands in for the production triggers. The
 * first snapshot is not replayed as changes: it is the state at start, which the backfill
 * copies. That's why the listener can start before the backfill without leaving a gap.
 */
export function listenToFirestore(
  db: Firestore,
  handlers: ListenerHandlers,
  logger: Logger,
): () => void {
  const unsubscribes = COLLECTIONS.map((collection) => {
    let initial = true;
    return db.collection(collection).onSnapshot(
      (snapshot) => {
        if (initial) {
          initial = false;
          handlers.onInitial(collection, snapshot.docs.map(toRawDoc));
          return;
        }
        for (const change of snapshot.docChanges()) {
          handlers.onEvent(
            change.type === "removed"
              ? { kind: "delete", collection, legacyId: change.doc.id }
              : { kind: "upsert", collection, doc: toRawDoc(change.doc) },
          );
        }
      },
      (error) => logger.error({ err: error, collection }, "listener failed"),
    );
  });
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

function toRawDoc(doc: QueryDocumentSnapshot): RawDoc {
  return { id: doc.id, updateTime: doc.updateTime.toDate(), data: toPlain(doc.data()) };
}
