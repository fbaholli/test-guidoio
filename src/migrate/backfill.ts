import type pg from "pg";
import type { Logger } from "pino";
import { COLLECTIONS, type CollectionName } from "../source/collections.js";
import type { SourceReader } from "../source/types.js";
import { chunk } from "../util/chunk.js";
import { compareCodeUnits } from "../util/order.js";
import { applyDocs, applyStudentItems, type BatchOutcome, prepareStudentItems } from "./apply.js";
import { readCheckpoint, saveCheckpoint } from "./checkpoints.js";
import { loadContext } from "./id-map.js";
import { loadRejectSummaries, type RejectSummary } from "./report.js";
import { findUnfinishedBackfill, finishRun, saveStats, startRun } from "./runs.js";
import { count, type RunStats, statsFor } from "./stats.js";

export type BackfillOptions = {
  reader: SourceReader;
  batchSize: number;
  dryRun: boolean;
  resume: boolean;
  only?: CollectionName;
  timeZone: string;
  logger: Logger;
  /** Test hook: stop as if the process died right after this many committed batches. */
  stopAfterBatches?: number;
};

export type BackfillResult = {
  runId: string;
  resumed: boolean;
  dryRun: boolean;
  stats: RunStats;
  rejects: RejectSummary[];
};

export class SimulatedCrash extends Error {
  constructor(batches: number) {
    super(`simulated crash after ${batches} committed batches`);
    this.name = "SimulatedCrash";
  }
}

type RunState = BackfillResult & { batches: number };

/**
 * Collections run in foreign-key order. Each batch is one transaction holding its rows,
 * rejects, warnings, checkpoint and running stats, so a crash loses at most the batch in
 * flight, and `--resume` continues after the last one that committed. A dry run does all of
 * it inside one outer transaction and rolls it back; only the run record survives.
 */
export async function runBackfill(
  pool: pg.Pool,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const run = await openRun(pool, options);
  options.logger.info(
    { runId: run.runId, resumed: run.resumed, dryRun: run.dryRun },
    "backfill started",
  );

  const client = await pool.connect();
  try {
    if (options.dryRun) await client.query("begin");
    for (const collection of options.only ? [options.only] : COLLECTIONS) {
      if (collection === "students") await backfillStudents(client, run, options);
      else await backfillPages(client, run, collection, options);
      options.logger.info({ collection, ...statsFor(run.stats, collection) }, "collection done");
    }
  } finally {
    if (options.dryRun) await client.query("rollback").catch(() => undefined);
    client.release();
  }

  await finishRun(pool, run.runId, run.stats);
  const { batches: _batches, ...result } = run;
  return result;
}

async function openRun(pool: pg.Pool, options: BackfillOptions): Promise<RunState> {
  const base = { dryRun: options.dryRun, batches: 0 };
  if (options.resume && !options.dryRun) {
    const unfinished = await findUnfinishedBackfill(pool, options.reader.name);
    if (unfinished) {
      const rejects = await loadRejectSummaries(pool, unfinished.id);
      return { ...base, runId: unfinished.id, resumed: true, stats: unfinished.stats, rejects };
    }
    options.logger.warn("no unfinished backfill to resume; starting a new run");
  }
  const runId = await startRun(pool, "backfill", options.reader.name, options.dryRun);
  return { ...base, runId, resumed: false, stats: {}, rejects: [] };
}

async function backfillPages(
  client: pg.ClientBase,
  run: RunState,
  collection: Exclude<CollectionName, "students">,
  options: BackfillOptions,
): Promise<void> {
  const context = await loadContext(client, options.timeZone);
  let afterId = await readCheckpoint(client, run.runId, collection);
  for (;;) {
    const docs = await options.reader.readPage(collection, afterId, options.batchSize);
    const last = docs.at(-1);
    if (!last) return;
    await commitBatch(client, run, collection, last.id, options, () =>
      applyDocs(client, run.runId, collection, docs, context),
    );
    afterId = last.id;
  }
}

async function backfillStudents(
  client: pg.ClientBase,
  run: RunState,
  options: BackfillOptions,
): Promise<void> {
  const context = await loadContext(client, options.timeZone);
  const docs = await readAll(options.reader, "students", options.batchSize);
  const checkpoint = await readCheckpoint(client, run.runId, "students");
  const pending = prepareStudentItems(docs, context).filter(
    (item) => checkpoint === undefined || compareCodeUnits(item.key, checkpoint) > 0,
  );
  for (const items of chunk(pending, options.batchSize)) {
    const lastKey = items.at(-1)?.key;
    if (lastKey === undefined) continue;
    await commitBatch(client, run, "students", lastKey, options, () =>
      applyStudentItems(client, run.runId, items),
    );
  }
}

async function commitBatch(
  client: pg.ClientBase,
  run: RunState,
  collection: CollectionName,
  lastKey: string,
  options: BackfillOptions,
  apply: () => Promise<BatchOutcome>,
): Promise<void> {
  await client.query(options.dryRun ? "savepoint batch" : "begin");
  try {
    const outcome = await apply();
    record(run, collection, outcome);
    await saveCheckpoint(client, run.runId, collection, lastKey);
    await saveStats(client, run.runId, run.stats);
    await client.query(options.dryRun ? "release savepoint batch" : "commit");
  } catch (error) {
    await client.query(options.dryRun ? "rollback to savepoint batch" : "rollback");
    throw error;
  }

  run.batches++;
  if (options.stopAfterBatches !== undefined && run.batches >= options.stopAfterBatches) {
    throw new SimulatedCrash(run.batches);
  }
}

function record(run: RunState, collection: CollectionName, outcome: BatchOutcome): void {
  const stats = statsFor(run.stats, collection);
  const inserted = outcome.changed.filter((row) => row.inserted).length;
  stats.read += outcome.read;
  stats.inserted += inserted;
  stats.updated += outcome.changed.length - inserted;
  stats.unchanged += outcome.imported - outcome.changed.length;
  stats.events += outcome.events;
  for (const reject of outcome.rejects) {
    count(stats.rejected, reject.reason);
    run.rejects.push({
      entity: reject.entity,
      legacyId: reject.legacyId,
      reason: reject.reason,
      detail: reject.detail,
    });
  }
  for (const warning of outcome.warnings) count(stats.warnings, warning.code);
}

async function readAll(reader: SourceReader, collection: CollectionName, pageSize: number) {
  const docs = [];
  let afterId: string | undefined;
  for (;;) {
    const page = await reader.readPage(collection, afterId, pageSize);
    docs.push(...page);
    afterId = page.at(-1)?.id;
    if (page.length < pageSize || afterId === undefined) return docs;
  }
}
