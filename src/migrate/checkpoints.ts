import type pg from "pg";
import { z } from "zod";

const checkpointSchema = z.object({ last_doc_id: z.string() });

export async function readCheckpoint(
  client: pg.ClientBase,
  runId: string,
  collection: string,
): Promise<string | undefined> {
  const { rows } = await client.query(
    "select last_doc_id from migration_checkpoints where run_id = $1 and collection = $2",
    [runId, collection],
  );
  return rows.length === 0 ? undefined : checkpointSchema.parse(rows[0]).last_doc_id;
}

/** Saved inside the batch's own transaction: a batch and its checkpoint commit together or not at all. */
export async function saveCheckpoint(
  client: pg.ClientBase,
  runId: string,
  collection: string,
  lastDocId: string,
): Promise<void> {
  await client.query(
    `insert into migration_checkpoints (run_id, collection, last_doc_id) values ($1, $2, $3)
     on conflict (run_id, collection) do update set last_doc_id = excluded.last_doc_id, updated_at = now()`,
    [runId, collection, lastDocId],
  );
}
