import type pg from "pg";
import type { RejectCode } from "../normalize/result.js";

export type RejectRecord = {
  entity: string;
  legacyId: string;
  reason: RejectCode;
  detail: string;
  /** The raw source document. Personal data: this table is access-restricted. */
  payload: unknown;
};

export async function insertRejects(
  client: pg.ClientBase,
  runId: string,
  rejects: readonly RejectRecord[],
): Promise<void> {
  if (rejects.length === 0) return;
  // A resumed run may record the same doc again; the latest reason wins.
  await client.query(
    `insert into migration_rejects (run_id, entity, legacy_id, reason_code, reason_detail, payload)
     select $1, e, l, r, d, p
     from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::jsonb[]) as t(e, l, r, d, p)
     on conflict (run_id, entity, legacy_id) do update
       set reason_code = excluded.reason_code, reason_detail = excluded.reason_detail, payload = excluded.payload`,
    [
      runId,
      rejects.map((r) => r.entity),
      rejects.map((r) => r.legacyId),
      rejects.map((r) => r.reason),
      rejects.map((r) => r.detail),
      rejects.map((r) => JSON.stringify(r.payload)),
    ],
  );
}
