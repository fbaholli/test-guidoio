import type pg from "pg";
import { z } from "zod";
import type { BookingRow } from "../normalize/bookings.js";
import type { CityRow } from "../normalize/cities.js";
import type { InstructorRow } from "../normalize/instructors.js";
import type { PickupPointRow } from "../normalize/pickup-points.js";
import type { MergedStudent } from "../normalize/students.js";

// One statement per batch: rows travel as column arrays through unnest(), so a batch costs
// one round trip whatever its size. Every upsert uses the same newer-wins rule as live sync:
// a row only changes when the incoming version is newer, so re-runs, duplicate events and
// out-of-order events are all harmless. A row the WHERE skips isn't returned: "unchanged".

export type ChangedRow = { legacyId: string; inserted: boolean };

const NEWER_WINS = (table: string) =>
  `where ${table}.legacy_updated_at is null or ${table}.legacy_updated_at < excluded.legacy_updated_at
   returning legacy_id, (xmax = 0) as inserted`;

const changedRows = z.array(z.object({ legacy_id: z.string(), inserted: z.boolean() }));

async function run(client: pg.ClientBase, sql: string, params: unknown[]): Promise<ChangedRow[]> {
  const { rows } = await client.query(sql, params);
  return changedRows
    .parse(rows)
    .map((row) => ({ legacyId: row.legacy_id, inserted: row.inserted }));
}

export function upsertCities(client: pg.ClientBase, rows: readonly CityRow[]) {
  return run(
    client,
    `insert into cities (legacy_id, name, region, created_at, legacy_updated_at)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[])
     on conflict (legacy_id) do update set
       name = excluded.name, region = excluded.region, created_at = excluded.created_at,
       legacy_updated_at = excluded.legacy_updated_at
     ${NEWER_WINS("cities")}`,
    [
      rows.map((r) => r.legacyId),
      rows.map((r) => r.name),
      rows.map((r) => r.region),
      rows.map((r) => r.createdAt),
      rows.map((r) => r.legacyUpdatedAt),
    ],
  );
}

export function upsertPickupPoints(client: pg.ClientBase, rows: readonly PickupPointRow[]) {
  return run(
    client,
    `insert into pickup_points (legacy_id, city_id, name, address, lat, lng, created_at, legacy_updated_at)
     select * from unnest($1::text[], $2::uuid[], $3::text[], $4::text[], $5::numeric[], $6::numeric[],
                          $7::timestamptz[], $8::timestamptz[])
     on conflict (legacy_id) do update set
       city_id = excluded.city_id, name = excluded.name, address = excluded.address,
       lat = excluded.lat, lng = excluded.lng, created_at = excluded.created_at,
       legacy_updated_at = excluded.legacy_updated_at
     ${NEWER_WINS("pickup_points")}`,
    [
      rows.map((r) => r.legacyId),
      rows.map((r) => r.cityId),
      rows.map((r) => r.name),
      rows.map((r) => r.address),
      rows.map((r) => r.lat),
      rows.map((r) => r.lng),
      rows.map((r) => r.createdAt),
      rows.map((r) => r.legacyUpdatedAt),
    ],
  );
}

export function upsertInstructors(client: pg.ClientBase, rows: readonly InstructorRow[]) {
  // unnest() flattens a 2-D array, so each row's categories travel as one comma-joined string.
  return run(
    client,
    `insert into instructors (legacy_id, city_id, full_name, email, phone_e164, license_categories,
                              active, created_at, legacy_updated_at)
     select l, c, n, e, p, string_to_array(cats, ','), a, ca, u
     from unnest($1::text[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bool[],
                 $8::timestamptz[], $9::timestamptz[]) as t(l, c, n, e, p, cats, a, ca, u)
     on conflict (legacy_id) do update set
       city_id = excluded.city_id, full_name = excluded.full_name, email = excluded.email,
       phone_e164 = excluded.phone_e164, license_categories = excluded.license_categories,
       active = excluded.active, created_at = excluded.created_at,
       legacy_updated_at = excluded.legacy_updated_at
     ${NEWER_WINS("instructors")}`,
    [
      rows.map((r) => r.legacyId),
      rows.map((r) => r.cityId),
      rows.map((r) => r.fullName),
      rows.map((r) => r.email),
      rows.map((r) => r.phoneE164),
      rows.map((r) => r.licenseCategories.join(",")),
      rows.map((r) => r.active),
      rows.map((r) => r.createdAt),
      rows.map((r) => r.legacyUpdatedAt),
    ],
  );
}

export function upsertStudents(client: pg.ClientBase, rows: readonly MergedStudent[]) {
  return run(
    client,
    `insert into students (legacy_id, city_id, first_name, last_name, email, phone_e164, tax_code,
                           license_category, deleted_at, created_at, legacy_updated_at)
     select * from unnest($1::text[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[],
                          $7::text[], $8::text[], $9::timestamptz[], $10::timestamptz[], $11::timestamptz[])
     on conflict (legacy_id) do update set
       city_id = excluded.city_id, first_name = excluded.first_name, last_name = excluded.last_name,
       email = excluded.email, phone_e164 = excluded.phone_e164, tax_code = excluded.tax_code,
       license_category = excluded.license_category, deleted_at = excluded.deleted_at,
       created_at = excluded.created_at, legacy_updated_at = excluded.legacy_updated_at
     ${NEWER_WINS("students")}`,
    [
      rows.map((r) => r.legacyId),
      rows.map((r) => r.cityId),
      rows.map((r) => r.firstName),
      rows.map((r) => r.lastName),
      rows.map((r) => r.email),
      rows.map((r) => r.phoneE164),
      rows.map((r) => r.taxCode),
      rows.map((r) => r.licenseCategory),
      rows.map((r) => r.deletedAt),
      rows.map((r) => r.createdAt),
      rows.map((r) => r.legacyUpdatedAt),
    ],
  );
}

export function upsertBookings(client: pg.ClientBase, rows: readonly BookingRow[]) {
  return run(
    client,
    `insert into bookings (legacy_id, student_id, instructor_id, pickup_point_id, starts_at, ends_at,
                           status, price_cents, paid, notes, deleted_at, created_at, legacy_updated_at)
     select * from unnest($1::text[], $2::uuid[], $3::uuid[], $4::uuid[], $5::timestamptz[],
                          $6::timestamptz[], $7::text[], $8::int[], $9::bool[], $10::text[],
                          $11::timestamptz[], $12::timestamptz[], $13::timestamptz[])
     on conflict (legacy_id) do update set
       student_id = excluded.student_id, instructor_id = excluded.instructor_id,
       pickup_point_id = excluded.pickup_point_id, starts_at = excluded.starts_at,
       ends_at = excluded.ends_at, status = excluded.status, price_cents = excluded.price_cents,
       paid = excluded.paid, notes = excluded.notes, deleted_at = excluded.deleted_at,
       created_at = excluded.created_at, legacy_updated_at = excluded.legacy_updated_at
     ${NEWER_WINS("bookings")}`,
    [
      rows.map((r) => r.legacyId),
      rows.map((r) => r.studentId),
      rows.map((r) => r.instructorId),
      rows.map((r) => r.pickupPointId),
      rows.map((r) => r.startsAt),
      rows.map((r) => r.endsAt),
      rows.map((r) => r.status),
      rows.map((r) => r.priceCents),
      rows.map((r) => r.paid),
      rows.map((r) => r.notes),
      rows.map((r) => r.deletedAt),
      rows.map((r) => r.createdAt),
      rows.map((r) => r.legacyUpdatedAt),
    ],
  );
}

/** History → booking_events. The unique key makes a re-run add nothing. Returns rows added. */
export async function insertBookingEvents(
  client: pg.ClientBase,
  rows: readonly BookingRow[],
  source: "firestore" | "api" = "firestore",
): Promise<number> {
  const events = rows.flatMap((row) =>
    row.events.map((event) => ({ legacyId: row.legacyId, ...event })),
  );
  if (events.length === 0) return 0;
  const result = await client.query(
    `insert into booking_events (booking_id, status, occurred_at, actor, source)
     select b.id, e.status, e.occurred_at, e.actor, $5
     from unnest($1::text[], $2::text[], $3::timestamptz[], $4::text[]) as e(legacy_id, status, occurred_at, actor)
     join bookings b on b.legacy_id = e.legacy_id
     on conflict do nothing`,
    [
      events.map((e) => e.legacyId),
      events.map((e) => e.status),
      events.map((e) => e.occurredAt),
      events.map((e) => e.actor),
      source,
    ],
  );
  return result.rowCount ?? 0;
}
