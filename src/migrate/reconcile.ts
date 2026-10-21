import { DateTime } from "luxon";
import type pg from "pg";
import { z } from "zod";
import { normalizeBooking } from "../normalize/bookings.js";
import { normalizeCity } from "../normalize/cities.js";
import type { NormalizeContext } from "../normalize/context.js";
import { normalizeInstructor } from "../normalize/instructors.js";
import { normalizePickupPoint } from "../normalize/pickup-points.js";
import type { NormalizeResult } from "../normalize/result.js";
import {
  mergeDuplicateStudents,
  normalizeStudent,
  type StudentCandidate,
} from "../normalize/students.js";
import type { CollectionName } from "../source/collections.js";
import { readAll } from "../source/read-all.js";
import type { RawDoc, SourceReader } from "../source/types.js";
import { type CanonicalRecord, coordinate, fromSource, iso, sortEvents } from "./canonical.js";
import { loadContext } from "./id-map.js";
import {
  compareEntity,
  differingMonths,
  type EntityComparison,
  isClean,
  type MonthTotals,
  type PgEntry,
  type SourceEntry,
} from "./reconcile-compare.js";
import { finishRun, startRun } from "./runs.js";
import { ENTITY_BY_COLLECTION } from "./stats.js";

export type ReconcileResult = {
  runId: string;
  clean: boolean;
  entities: Record<CollectionName, EntityComparison>;
  differingMonths: string[];
  apiRows: number;
};

/**
 * Proves the two stores hold the same data: counts, a checksum per record and monthly
 * totals. Firestore docs go through the same normalisers as the backfill, so a difference is
 * a real difference, not a formatting one. The cutover gate: clean means exit code 0.
 */
export async function reconcile(
  pool: pg.Pool,
  reader: SourceReader,
  timeZone: string,
): Promise<ReconcileResult> {
  const runId = await startRun(pool, "reconcile", reader.name, false);
  const client = await pool.connect();
  try {
    const context = await loadContext(client, timeZone);
    const everRejected = await loadEverRejected(client);
    const pg = await loadPgRecords(client);
    const sourceBookings = new Map<string, SourceEntry>();
    const compare = async (collection: CollectionName): Promise<EntityComparison> => {
      const docs = await readAll(reader, collection);
      const { entries, mergedDuplicates } = sourceEntries(collection, docs, context);
      if (collection === "bookings")
        for (const [id, entry] of entries) sourceBookings.set(id, entry);
      return compareEntity({
        source: entries,
        sourceDocs: docs.length,
        mergedDuplicates,
        pg: pg[collection],
        everRejected: everRejected.get(ENTITY_BY_COLLECTION[collection]) ?? new Set(),
      });
    };
    // Awaited one by one, in foreign-key order.
    const entities: Record<CollectionName, EntityComparison> = {
      cities: await compare("cities"),
      pickupPoints: await compare("pickupPoints"),
      instructors: await compare("instructors"),
      students: await compare("students"),
      bookings: await compare("bookings"),
    };

    const gaps = new Set(entities.bookings.expectedGaps);
    const months = differingMonths(
      monthTotals(
        [...sourceBookings].filter(([id]) => !gaps.has(id)).map(([, e]) => e),
        timeZone,
      ),
      monthTotals([...pg.bookings.values()], timeZone),
    );
    const apiRows = await countApiRows(client);
    const clean = Object.values(entities).every(isClean) && months.length === 0;
    const result = { runId, clean, entities, differingMonths: months, apiRows };
    await finishRun(pool, runId, result);
    return result;
  } finally {
    client.release();
  }
}

function sourceEntries(
  collection: CollectionName,
  docs: readonly RawDoc[],
  context: NormalizeContext,
): { entries: Map<string, SourceEntry>; mergedDuplicates: number } {
  const entries = new Map<string, SourceEntry>();
  const add = <R>(
    id: string,
    result: NormalizeResult<R>,
    canonical: (row: R) => CanonicalRecord,
  ) => {
    entries.set(
      id,
      result.ok
        ? { kind: "record", record: canonical(result.value) }
        : { kind: "rejected", reason: result.reason },
    );
  };

  switch (collection) {
    case "cities":
      for (const doc of docs) add(doc.id, normalizeCity(doc), fromSource.city);
      return { entries, mergedDuplicates: 0 };
    case "pickupPoints":
      for (const doc of docs)
        add(doc.id, normalizePickupPoint(doc, context), fromSource.pickupPoint);
      return { entries, mergedDuplicates: 0 };
    case "instructors":
      for (const doc of docs) add(doc.id, normalizeInstructor(doc, context), fromSource.instructor);
      return { entries, mergedDuplicates: 0 };
    case "bookings":
      for (const doc of docs) add(doc.id, normalizeBooking(doc, context), fromSource.booking);
      return { entries, mergedDuplicates: 0 };
    case "students": {
      const candidates: StudentCandidate[] = [];
      for (const doc of docs) {
        const result = normalizeStudent(doc, context);
        if (result.ok) candidates.push(result.value);
        else entries.set(doc.id, { kind: "rejected", reason: result.reason });
      }
      const { students, duplicates } = mergeDuplicateStudents(candidates);
      for (const student of students)
        entries.set(student.legacyId, { kind: "record", record: fromSource.student(student) });
      return { entries, mergedDuplicates: duplicates.length };
    }
  }
}

async function loadEverRejected(client: pg.ClientBase): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query("select distinct entity, legacy_id from migration_rejects");
  const byEntity = new Map<string, Set<string>>();
  for (const row of z.array(z.object({ entity: z.string(), legacy_id: z.string() })).parse(rows)) {
    byEntity.set(row.entity, (byEntity.get(row.entity) ?? new Set()).add(row.legacy_id));
  }
  return byEntity;
}

const date = z.date();
const nullableDate = z.date().nullable();
const text = z.string().nullable();

/** Postgres rows in the same canonical form, keyed by legacy id. API-created bookings are left out. */
async function loadPgRecords(
  client: pg.ClientBase,
): Promise<Record<CollectionName, Map<string, PgEntry>>> {
  const keyed = <T extends { legacy_id: string }>(rows: T[], toEntry: (row: T) => PgEntry) =>
    new Map(rows.map((row) => [row.legacy_id, toEntry(row)]));

  const cities = z
    .array(z.object({ legacy_id: z.string(), name: z.string(), region: text }))
    .parse((await client.query("select legacy_id, name, region from cities")).rows);

  const pickups = z
    .array(
      z.object({
        legacy_id: z.string(),
        city: z.string(),
        name: z.string(),
        address: text,
        lat: text,
        lng: text,
      }),
    )
    .parse(
      (
        await client.query(
          `select p.legacy_id, c.legacy_id as city, p.name, p.address, p.lat::text, p.lng::text
           from pickup_points p join cities c on c.id = p.city_id`,
        )
      ).rows,
    );

  const instructors = z
    .array(
      z.object({
        legacy_id: z.string(),
        city: z.string(),
        full_name: z.string(),
        email: text,
        phone_e164: text,
        license_categories: z.array(z.string()),
        active: z.boolean(),
      }),
    )
    .parse(
      (
        await client.query(
          `select i.legacy_id, c.legacy_id as city, i.full_name, i.email, i.phone_e164, i.license_categories, i.active
           from instructors i join cities c on c.id = i.city_id`,
        )
      ).rows,
    );

  const students = z
    .array(
      z.object({
        legacy_id: z.string(),
        legacy_ids: z.array(z.string()),
        city: text,
        first_name: z.string(),
        last_name: z.string(),
        email: text,
        phone_e164: text,
        tax_code: text,
        license_category: text,
        deleted_at: nullableDate,
        created_at: date,
      }),
    )
    .parse(
      (
        await client.query(
          `select s.legacy_id, c.legacy_id as city, s.first_name, s.last_name, s.email, s.phone_e164, s.tax_code,
                  s.license_category, s.deleted_at, s.created_at,
                  array(select m.legacy_id from legacy_id_map m
                        where m.entity = 'student' and m.new_id = s.id order by m.legacy_id) as legacy_ids
           from students s left join cities c on c.id = s.city_id`,
        )
      ).rows,
    );

  const bookings = z
    .array(
      z.object({
        legacy_id: z.string(),
        student: z.string(),
        instructor: z.string(),
        pickup: text,
        starts_at: date,
        ends_at: date,
        status: z.string(),
        price_cents: z.number().nullable(),
        paid: z.boolean(),
        notes: text,
        deleted_at: nullableDate,
        created_at: date,
        events: z.array(z.object({ status: z.string(), occurredAt: z.string(), actor: text })),
      }),
    )
    .parse(
      (
        await client.query(
          `select b.legacy_id, s.legacy_id as student, i.legacy_id as instructor, p.legacy_id as pickup,
                  b.starts_at, b.ends_at, b.status, b.price_cents, b.paid, b.notes, b.deleted_at, b.created_at,
                  coalesce((select json_agg(json_build_object('status', e.status, 'occurredAt', e.occurred_at, 'actor', e.actor))
                            from booking_events e where e.booking_id = b.id), '[]') as events
           from bookings b join students s on s.id = b.student_id join instructors i on i.id = b.instructor_id
           left join pickup_points p on p.id = b.pickup_point_id
           where b.source = 'firestore'`,
        )
      ).rows,
    );

  return {
    cities: keyed(cities, (r) => ({ record: { name: r.name, region: r.region }, deleted: false })),
    pickupPoints: keyed(pickups, (r) => ({
      record: {
        city: r.city,
        name: r.name,
        address: r.address,
        lat: coordinate(r.lat),
        lng: coordinate(r.lng),
      },
      deleted: false,
    })),
    instructors: keyed(instructors, (r) => ({
      record: {
        city: r.city,
        fullName: r.full_name,
        email: r.email,
        phoneE164: r.phone_e164,
        licenseCategories: r.license_categories,
        active: r.active,
      },
      deleted: false,
    })),
    students: keyed(students, (r) => ({
      record: {
        legacyIds: r.legacy_ids,
        city: r.city,
        firstName: r.first_name,
        lastName: r.last_name,
        email: r.email,
        phoneE164: r.phone_e164,
        taxCode: r.tax_code,
        licenseCategory: r.license_category,
        deleted: r.deleted_at !== null,
        createdAt: iso(r.created_at),
      },
      deleted: r.deleted_at !== null,
    })),
    bookings: keyed(bookings, (r) => ({
      record: {
        student: r.student,
        instructor: r.instructor,
        pickupPoint: r.pickup,
        startsAt: iso(r.starts_at),
        endsAt: iso(r.ends_at),
        status: r.status,
        priceCents: r.price_cents,
        paid: r.paid,
        notes: r.notes,
        deleted: r.deleted_at !== null,
        createdAt: iso(r.created_at),
        // json_agg writes timestamps as "2026-09-01T08:00:00+00:00"; normalise to ISO with Z.
        events: sortEvents(
          r.events.map((e) => ({ ...e, occurredAt: new Date(e.occurredAt).toISOString() })),
        ),
      },
      deleted: r.deleted_at !== null,
    })),
  };
}

/** Active lessons and their value per Rome month, the numbers a business owner would check. */
function monthTotals(entries: ReadonlyArray<SourceEntry | PgEntry>, timeZone: string): MonthTotals {
  const totals: MonthTotals = {};
  for (const entry of entries) {
    const record = "record" in entry ? entry.record : undefined;
    if (!record || record.deleted === true) continue;
    if (record.status !== "booked" && record.status !== "confirmed") continue;
    const month = DateTime.fromISO(String(record.startsAt)).setZone(timeZone).toFormat("yyyy-MM");
    const current = totals[month] ?? { activeBookings: 0, priceCents: 0 };
    current.activeBookings += 1;
    current.priceCents += typeof record.priceCents === "number" ? record.priceCents : 0;
    totals[month] = current;
  }
  return totals;
}

async function countApiRows(client: pg.ClientBase): Promise<number> {
  const { rows } = await client.query(
    "select count(*)::int as n from bookings where source = 'api'",
  );
  return z.array(z.object({ n: z.number() })).parse(rows)[0]?.n ?? 0;
}
