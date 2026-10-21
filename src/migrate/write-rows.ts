import type pg from "pg";
import { isPgError, type PgError, SQLSTATE } from "../db/errors.js";
import type { RejectCode } from "../normalize/result.js";
import type { ChangedRow } from "./upsert.js";

export type RowFailure = { reason: RejectCode; detail: string };
export type FailedRow<R> = { row: R } & RowFailure;

/** Constraint errors that belong to one bad row; anything else is a real failure and is thrown. */
const ROW_LEVEL_ERRORS: ReadonlySet<string> = new Set([
  SQLSTATE.exclusionViolation,
  SQLSTATE.foreignKeyViolation,
  SQLSTATE.checkViolation,
  SQLSTATE.uniqueViolation,
  SQLSTATE.notNullViolation,
]);

/**
 * Writes a batch in one statement and, if a row breaks a constraint, finds it by splitting:
 * roll back to a savepoint, write the first half, then the second half, down to the single
 * bad row. The halves go in order, so "first in wins" holds exactly as with row-by-row
 * savepoints, but a clean batch costs one round trip and a batch with k bad rows about
 * k·log₂(n). That matters when the database sits across a network.
 * Production note: at scale, COPY into a staging table and find overlaps with one set-based
 * query before inserting.
 */
export async function writeRows<R>(
  client: pg.ClientBase,
  rows: readonly R[],
  write: (rows: readonly R[]) => Promise<ChangedRow[]>,
  explain: (row: R, error: PgError) => Promise<RowFailure>,
): Promise<{ changed: ChangedRow[]; failed: Array<FailedRow<R>> }> {
  const changed: ChangedRow[] = [];
  const failed: Array<FailedRow<R>> = [];

  const attempt = async (part: readonly R[]): Promise<void> => {
    if (part.length === 0) return;
    await client.query("savepoint write_rows");
    try {
      changed.push(...(await write(part)));
      await client.query("release savepoint write_rows");
      return;
    } catch (error) {
      await client.query("rollback to savepoint write_rows");
      await client.query("release savepoint write_rows");
      if (!isPgError(error) || !ROW_LEVEL_ERRORS.has(error.code)) throw error;
      const [only] = part;
      if (part.length === 1 && only !== undefined) {
        failed.push({ row: only, ...(await explain(only, error)) });
        return;
      }
    }
    const middle = Math.ceil(part.length / 2);
    await attempt(part.slice(0, middle));
    await attempt(part.slice(middle));
  };

  await attempt(rows);
  return { changed, failed };
}

/** For tables without special constraints: name the constraint, never the values. */
export async function explainGeneric(_row: unknown, error: PgError): Promise<RowFailure> {
  return {
    reason: "INVALID_RECORD",
    detail: `violates ${error.constraint ?? `SQLSTATE ${error.code}`}`,
  };
}
