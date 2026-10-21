import type { CollectionName } from "./collections.js";
import type { RawDoc, SourceReader } from "./types.js";

/**
 * Every doc in a collection, still read page by page. Only an empty page ends the read: a
 * short page is not proof of the end (a filtering reader can return fewer docs mid-way).
 */
export async function readAll(
  reader: SourceReader,
  collection: CollectionName,
  pageSize = 500,
): Promise<RawDoc[]> {
  const docs: RawDoc[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = await reader.readPage(collection, afterId, pageSize);
    const last = page.at(-1);
    if (!last) return docs;
    docs.push(...page);
    afterId = last.id;
  }
}
