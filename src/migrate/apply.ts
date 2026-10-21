import type pg from "pg";
import { type BookingRow, normalizeBooking } from "../normalize/bookings.js";
import { normalizeCity } from "../normalize/cities.js";
import type { NormalizeContext } from "../normalize/context.js";
import { normalizeInstructor } from "../normalize/instructors.js";
import { normalizePickupPoint } from "../normalize/pickup-points.js";
import type { NormalizeResult, Warning } from "../normalize/result.js";
import {
  type MergedStudent,
  mergeDuplicateStudents,
  normalizeStudent,
} from "../normalize/students.js";
import type { CollectionName } from "../source/collections.js";
import type { RawDoc } from "../source/types.js";
import { compareCodeUnits } from "../util/order.js";
import { explainBookingFailure } from "./explain-booking.js";
import { idsByLegacyId, saveIdMap } from "./id-map.js";
import { insertRejects, type RejectRecord } from "./rejects.js";
import { ENTITY_BY_COLLECTION } from "./stats.js";
import {
  type ChangedRow,
  insertBookingEvents,
  upsertBookings,
  upsertCities,
  upsertInstructors,
  upsertPickupPoints,
  upsertStudents,
} from "./upsert.js";
import { insertWarnings, type WarningRecord } from "./warnings.js";
import { explainGeneric, writeRows } from "./write-rows.js";

// Normalise → write → record. Shared by the backfill (a page of docs) and live sync (one doc),
// so both paths apply exactly the same rules.

export type BatchOutcome = {
  read: number;
  changed: ChangedRow[];
  imported: number;
  rejects: RejectRecord[];
  warnings: WarningRecord[];
  events: number;
};

type Table = "cities" | "pickup_points" | "instructors" | "bookings";

type EntitySpec<R extends { legacyId: string }> = {
  table: Table;
  normalize: (doc: RawDoc) => NormalizeResult<R>;
  upsert: (client: pg.ClientBase, rows: readonly R[]) => Promise<ChangedRow[]>;
  explain: (
    client: pg.ClientBase,
    row: R,
    error: Parameters<typeof explainGeneric>[1],
  ) => ReturnType<typeof explainGeneric>;
  afterWrite?: (client: pg.ClientBase, rows: readonly R[]) => Promise<number>;
};

/** Cities, pickup points, instructors or bookings. Students go through applyStudentItems. */
export function applyDocs(
  client: pg.ClientBase,
  runId: string,
  collection: Exclude<CollectionName, "students">,
  docs: readonly RawDoc[],
  context: NormalizeContext,
): Promise<BatchOutcome> {
  const generic = {
    explain: (_c: pg.ClientBase, row: unknown, error: Parameters<typeof explainGeneric>[1]) =>
      explainGeneric(row, error),
  };
  switch (collection) {
    case "cities":
      return applyEntity(client, runId, collection, docs, {
        table: "cities",
        normalize: normalizeCity,
        upsert: upsertCities,
        ...generic,
      });
    case "pickupPoints":
      return applyEntity(client, runId, collection, docs, {
        table: "pickup_points",
        normalize: (doc) => normalizePickupPoint(doc, context),
        upsert: upsertPickupPoints,
        ...generic,
      });
    case "instructors":
      return applyEntity(client, runId, collection, docs, {
        table: "instructors",
        normalize: (doc) => normalizeInstructor(doc, context),
        upsert: upsertInstructors,
        ...generic,
      });
    case "bookings":
      return applyEntity<BookingRow>(client, runId, collection, docs, {
        table: "bookings",
        normalize: (doc) => normalizeBooking(doc, context),
        upsert: upsertBookings,
        explain: explainBookingFailure,
        afterWrite: (c, rows) => insertBookingEvents(c, rows),
      });
  }
}

async function applyEntity<R extends { legacyId: string }>(
  client: pg.ClientBase,
  runId: string,
  collection: CollectionName,
  docs: readonly RawDoc[],
  spec: EntitySpec<R>,
): Promise<BatchOutcome> {
  const entity = ENTITY_BY_COLLECTION[collection];
  const docsById = new Map(docs.map((doc) => [doc.id, doc]));
  const rejects: RejectRecord[] = [];
  const pending: Array<{ row: R; warnings: Warning[] }> = [];
  for (const doc of docs) {
    const result = spec.normalize(doc);
    if (result.ok) pending.push({ row: result.value, warnings: result.warnings });
    else
      rejects.push({
        entity,
        legacyId: doc.id,
        reason: result.reason,
        detail: result.detail,
        payload: doc.data,
      });
  }

  const { changed, failed } = await writeRows(
    client,
    pending.map((p) => p.row),
    (rows) => spec.upsert(client, rows),
    (row, error) => spec.explain(client, row, error),
  );
  const failedIds = new Set(failed.map((f) => f.row.legacyId));
  for (const { row, reason, detail } of failed) {
    rejects.push({
      entity,
      legacyId: row.legacyId,
      reason,
      detail,
      payload: docsById.get(row.legacyId)?.data ?? {},
    });
  }

  // A doc is either rejected with one reason, or imported with its warnings.
  const imported = pending.filter((p) => !failedIds.has(p.row.legacyId));
  const ids = await idsByLegacyId(
    client,
    spec.table,
    imported.map((p) => p.row.legacyId),
  );
  await saveIdMap(
    client,
    entity,
    [...ids].map(([legacyId, newId]) => ({ legacyId, newId })),
  );
  const events = spec.afterWrite
    ? await spec.afterWrite(
        client,
        imported.map((p) => p.row),
      )
    : 0;
  const warnings = imported.flatMap((p) => toWarningRecords(entity, p.row.legacyId, p.warnings));

  await insertRejects(client, runId, rejects);
  await insertWarnings(client, runId, warnings);
  return { read: docs.length, changed, imported: imported.length, rejects, warnings, events };
}

/** A merged student with all its source docs, or a student doc that was rejected. */
export type StudentItem =
  | {
      kind: "student";
      key: string;
      student: MergedStudent;
      docs: RawDoc[];
      warnings: WarningRecord[];
    }
  | { kind: "reject"; key: string; reject: RejectRecord };

/**
 * Students need every doc before anything is written: two sign-ups by the same person can
 * sit in different pages. Items come back sorted by key (the surviving legacy id) so they can
 * be written, and checkpointed, in batches.
 */
export function prepareStudentItems(
  docs: readonly RawDoc[],
  context: NormalizeContext,
): StudentItem[] {
  const items: StudentItem[] = [];
  const warningsByDoc = new Map<string, Warning[]>();
  const candidates = [];
  for (const doc of docs) {
    const result = normalizeStudent(doc, context);
    if (result.ok) {
      candidates.push(result.value);
      warningsByDoc.set(doc.id, result.warnings);
    } else {
      const reject = {
        entity: "student",
        legacyId: doc.id,
        reason: result.reason,
        detail: result.detail,
        payload: doc.data,
      };
      items.push({ kind: "reject", key: doc.id, reject });
    }
  }

  const docsById = new Map(docs.map((doc) => [doc.id, doc]));
  const { students, duplicates } = mergeDuplicateStudents(candidates);
  const mergedInto = new Map(duplicates.map((d) => [d.legacyId, d.mergedInto]));
  for (const student of students) {
    const warnings = student.legacyIds.flatMap((legacyId) => {
      const merged = mergedInto.get(legacyId);
      const own = toWarningRecords("student", legacyId, warningsByDoc.get(legacyId) ?? []);
      return merged
        ? [
            {
              entity: "student",
              legacyId,
              code: "DUPLICATE_MERGED" as const,
              detail: `merged into ${merged}`,
            },
            ...own,
          ]
        : own;
    });
    const sourceDocs = student.legacyIds.flatMap((legacyId) => docsById.get(legacyId) ?? []);
    items.push({ kind: "student", key: student.legacyId, student, docs: sourceDocs, warnings });
  }
  return items.sort((a, b) => compareCodeUnits(a.key, b.key));
}

export async function applyStudentItems(
  client: pg.ClientBase,
  runId: string,
  items: readonly StudentItem[],
): Promise<BatchOutcome> {
  const rejects = items.flatMap((item) => (item.kind === "reject" ? [item.reject] : []));
  const merged = items.flatMap((item) => (item.kind === "student" ? [item] : []));

  const { changed, failed } = await writeRows(
    client,
    merged.map((item) => item.student),
    (rows) => upsertStudents(client, rows),
    explainGeneric,
  );
  const failedIds = new Set(failed.map((f) => f.row.legacyId));
  for (const { row, reason, detail } of failed) {
    const item = merged.find((m) => m.student.legacyId === row.legacyId);
    for (const doc of item?.docs ?? [])
      rejects.push({ entity: "student", legacyId: doc.id, reason, detail, payload: doc.data });
  }

  const imported = merged.filter((item) => !failedIds.has(item.student.legacyId));
  const ids = await idsByLegacyId(
    client,
    "students",
    imported.map((item) => item.student.legacyId),
  );
  const entries = imported.flatMap((item) => {
    const newId = ids.get(item.student.legacyId);
    return newId ? item.student.legacyIds.map((legacyId) => ({ legacyId, newId })) : [];
  });
  await saveIdMap(client, "student", entries);

  const warnings = imported.flatMap((item) => item.warnings);
  await insertRejects(client, runId, rejects);
  await insertWarnings(client, runId, warnings);
  const read = items.reduce(
    (sum, item) => sum + (item.kind === "student" ? item.docs.length : 1),
    0,
  );
  return { read, changed, imported: imported.length, rejects, warnings, events: 0 };
}

function toWarningRecords(
  entity: string,
  legacyId: string,
  warnings: readonly Warning[],
): WarningRecord[] {
  return warnings.map((w) => ({ entity, legacyId, code: w.code, detail: w.detail ?? null }));
}
