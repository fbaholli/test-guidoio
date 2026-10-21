import type pg from "pg";
import type { WarningCode } from "../normalize/result.js";

export type WarningRecord = {
  entity: string;
  legacyId: string;
  code: WarningCode;
  /** Field names and legacy ids only, never values. */
  detail: string | null;
};

export async function insertWarnings(
  client: pg.ClientBase,
  runId: string,
  warnings: readonly WarningRecord[],
): Promise<void> {
  if (warnings.length === 0) return;
  await client.query(
    `insert into migration_warnings (run_id, entity, legacy_id, code, detail)
     select $1, e, l, c, d from unnest($2::text[], $3::text[], $4::text[], $5::text[]) as t(e, l, c, d)`,
    [
      runId,
      warnings.map((w) => w.entity),
      warnings.map((w) => w.legacyId),
      warnings.map((w) => w.code),
      warnings.map((w) => w.detail),
    ],
  );
}
