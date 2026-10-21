import type pg from "pg";
import { z } from "zod";
import { type RunStats, runStatsSchema } from "./stats.js";

export type RunMode = "backfill" | "sync" | "reconcile";

const runRowSchema = z.object({ id: z.string(), stats: z.unknown() });

/** Created in its own committed statement, so even a dry run leaves a record that it happened. */
export async function startRun(
  pool: pg.Pool,
  mode: RunMode,
  source: string,
  dryRun: boolean,
): Promise<string> {
  const { rows } = await pool.query(
    "insert into migration_runs (mode, source, dry_run) values ($1, $2, $3) returning id",
    [mode, source, dryRun],
  );
  return runRowSchema.pick({ id: true }).parse(rows[0]).id;
}

/** The latest backfill from this source that never finished: the one `--resume` continues. */
export async function findUnfinishedBackfill(
  pool: pg.Pool,
  source: string,
): Promise<{ id: string; stats: RunStats } | undefined> {
  const { rows } = await pool.query(
    `select id, stats from migration_runs
     where mode = 'backfill' and source = $1 and not dry_run and finished_at is null
     order by started_at desc limit 1`,
    [source],
  );
  if (rows.length === 0) return undefined;
  const run = runRowSchema.parse(rows[0]);
  return { id: run.id, stats: runStatsSchema.parse(run.stats) };
}

export async function saveStats(
  client: pg.ClientBase,
  runId: string,
  stats: unknown,
): Promise<void> {
  await client.query("update migration_runs set stats = $2 where id = $1", [
    runId,
    JSON.stringify(stats),
  ]);
}

export async function finishRun(pool: pg.Pool, runId: string, stats: unknown): Promise<void> {
  await pool.query("update migration_runs set finished_at = now(), stats = $2 where id = $1", [
    runId,
    JSON.stringify(stats),
  ]);
}
