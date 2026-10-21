import type pg from "pg";
import type { Logger } from "pino";
import { normalizeEmail } from "../normalize/email.js";
import type { CollectionName } from "../source/collections.js";
import type { RawDoc } from "../source/types.js";
import { applyDocs, applyStudentItems, type BatchOutcome, prepareStudentItems } from "./apply.js";
import { loadContext } from "./id-map.js";
import { finishRun, saveStats, startRun } from "./runs.js";
import { count, type RunStats, statsFor } from "./stats.js";

// Live sync: one source change at a time, through the same apply path as the backfill. The
// upsert only takes a version newer than the one stored, so a duplicate or out-of-order event
// changes nothing. Production note: Cloud Functions v2 onDocumentWritten → Pub/Sub → a Cloud
// Run worker calling syncDocument; delivery is at-least-once, which this makes safe.

export type SyncEvent =
  | { kind: "upsert"; collection: CollectionName; doc: RawDoc }
  | { kind: "delete"; collection: CollectionName; legacyId: string };

export type SyncOutcome = {
  legacyId: string;
  result: "inserted" | "updated" | "unchanged" | "rejected" | "soft-deleted" | "not-found";
  reason?: string;
};

export type SyncSession = {
  runId: string;
  /** Every student doc as last seen: merging needs all sign-ups that share an email. */
  students: Map<string, RawDoc>;
  stats: RunStats;
  timeZone: string;
  logger: Logger;
};

const SOFT_DELETABLE = { students: "students", bookings: "bookings" } as const;

export async function startSyncSession(
  pool: pg.Pool,
  options: { source: string; timeZone: string; logger: Logger; students?: Iterable<RawDoc> },
): Promise<SyncSession> {
  const runId = await startRun(pool, "sync", options.source, false);
  const students = new Map([...(options.students ?? [])].map((doc) => [doc.id, doc]));
  return { runId, students, stats: {}, timeZone: options.timeZone, logger: options.logger };
}

export async function stopSyncSession(pool: pg.Pool, session: SyncSession): Promise<void> {
  await finishRun(pool, session.runId, session.stats);
}

/** Applies one source change in its own transaction. */
export async function syncDocument(
  pool: pg.Pool,
  session: SyncSession,
  event: SyncEvent,
): Promise<SyncOutcome> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const outcome =
      event.kind === "delete"
        ? await softDelete(client, session, event.collection, event.legacyId)
        : await upsert(client, session, event.collection, event.doc);
    await saveStats(client, session.runId, session.stats);
    await client.query("commit");
    return outcome;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function upsert(
  client: pg.ClientBase,
  session: SyncSession,
  collection: CollectionName,
  doc: RawDoc,
): Promise<SyncOutcome> {
  const context = await loadContext(client, session.timeZone);
  if (collection !== "students") {
    const outcome = await applyDocs(client, session.runId, collection, [doc], context);
    return record(session, collection, doc.id, outcome);
  }

  // Rerun the merge for every sign-up sharing the old or the new email, so an edit to a
  // duplicate updates the merged student instead of overwriting it with its own fields.
  const previous = session.students.get(doc.id);
  session.students.set(doc.id, doc);
  const keys = new Set([emailKey(previous), emailKey(doc)].filter((key) => key !== null));
  const group = [...session.students.values()].filter((d) => {
    const key = emailKey(d);
    return d.id === doc.id || (key !== null && keys.has(key));
  });
  const items = prepareStudentItems(group, context);
  const outcome = await applyStudentItems(client, session.runId, items);
  const survivor = items.find(
    (item) => item.kind === "student" && item.student.legacyIds.includes(doc.id),
  );
  return record(session, collection, survivor?.key ?? doc.id, outcome);
}

/**
 * A doc removed from Firestore is soft-deleted here, never hard-deleted. Only students and
 * bookings have deleted_at; a removed city, pickup point or instructor is left in place and
 * reported, and reconciliation will flag it for a person to decide.
 */
async function softDelete(
  client: pg.ClientBase,
  session: SyncSession,
  collection: CollectionName,
  legacyId: string,
): Promise<SyncOutcome> {
  if (collection === "students") session.students.delete(legacyId);
  const table =
    collection === "students" || collection === "bookings" ? SOFT_DELETABLE[collection] : undefined;
  if (!table) {
    session.logger.warn(
      { collection, legacyId },
      "source doc deleted; this table has no soft delete, row left in place",
    );
    return { legacyId, result: "not-found", reason: "no soft delete for this collection" };
  }
  const result = await client.query(
    `update ${table} set deleted_at = now() where legacy_id = $1 and deleted_at is null`,
    [legacyId],
  );
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) statsFor(session.stats, collection).softDeleted++;
  return { legacyId, result: deleted ? "soft-deleted" : "not-found" };
}

function record(
  session: SyncSession,
  collection: CollectionName,
  legacyId: string,
  outcome: BatchOutcome,
): SyncOutcome {
  const stats = statsFor(session.stats, collection);
  const inserted = outcome.changed.filter((row) => row.inserted).length;
  stats.read += outcome.read;
  stats.inserted += inserted;
  stats.updated += outcome.changed.length - inserted;
  stats.unchanged += outcome.imported - outcome.changed.length;
  stats.events += outcome.events;
  for (const reject of outcome.rejects) count(stats.rejected, reject.reason);
  for (const warning of outcome.warnings) count(stats.warnings, warning.code);

  const reject = outcome.rejects[0];
  if (reject && outcome.imported === 0)
    return { legacyId, result: "rejected", reason: reject.reason };
  if (inserted > 0) return { legacyId, result: "inserted" };
  return { legacyId, result: outcome.changed.length > 0 ? "updated" : "unchanged" };
}

function emailKey(doc: RawDoc | undefined): string | null {
  return doc ? normalizeEmail(doc.data.email).matchKey : null;
}
