import type { CollectionName } from "./collections.js";

/**
 * One source document, whichever reader produced it. Firestore Timestamps arrive as Date, so
 * a Date means "this was a real timestamp"; strings and numbers are left exactly as stored.
 */
export type RawDoc = {
  id: string;
  updateTime: Date;
  data: Record<string, unknown>;
};

/** Reads one collection in document-id order, a page at a time. */
export type SourceReader = {
  readonly name: "emulator" | "firestore" | "json";
  readPage(
    collection: CollectionName,
    afterId: string | undefined,
    limit: number,
  ): Promise<RawDoc[]>;
  close(): Promise<void>;
};
