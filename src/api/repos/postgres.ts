import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../../db/types.js";
import { ApiError } from "../errors.js";
import type { BookingsReader, BookingsWriter, BookingView } from "./types.js";

type Db = Kysely<DB>;

/**
 * Reads and writes Postgres, speaking legacy ids at the edge: legacy_id_map turns the app's
 * Firestore ids into uuids, and the joins turn uuids back into legacy ids.
 */
export function postgresBookings(db: Db): BookingsReader & BookingsWriter {
  return {
    getByLegacyId: async (legacyId) => {
      const row = await bookingViews(db)
        .innerJoin("legacy_id_map as m", "m.new_id", "b.id")
        .where("m.entity", "=", "booking")
        .where("m.legacy_id", "=", legacyId)
        .executeTakeFirst();
      return row && toView(row);
    },

    listForInstructor: async (instructorLegacyId, from, to) => {
      const instructorId = await resolve(db, "instructor", instructorLegacyId);
      if (!instructorId) return undefined;
      const rows = await bookingViews(db)
        .where("b.instructor_id", "=", instructorId)
        .where("b.deleted_at", "is", null)
        .where("b.starts_at", "<", to)
        .where("b.ends_at", ">", from)
        .orderBy("b.starts_at")
        .execute();
      return rows.map(toView);
    },

    create: (input) =>
      db.transaction().execute(async (trx) => {
        const studentId = await resolve(trx, "student", input.studentId);
        const instructorId = await resolve(trx, "instructor", input.instructorId);
        const pickupPointId =
          input.pickupPointId === null
            ? null
            : ((await resolve(trx, "pickup_point", input.pickupPointId)) ?? undefined);
        const missing = [
          ...(studentId ? [] : ["studentId"]),
          ...(instructorId ? [] : ["instructorId"]),
          ...(pickupPointId === undefined ? ["pickupPointId"] : []),
        ];
        if (!studentId || !instructorId || pickupPointId === undefined) {
          throw new ApiError(422, "UNKNOWN_REFERENCE", `Not found: ${missing.join(", ")}`);
        }

        // New bookings have no Firestore doc, so they get an id the app can use the same way.
        const id = randomUUID();
        const legacyId = `api_${id}`;
        const endsAt = new Date(input.startsAt.getTime() + input.durationMin * 60_000);
        await trx
          .insertInto("bookings")
          .values({
            id,
            legacy_id: legacyId,
            student_id: studentId,
            instructor_id: instructorId,
            pickup_point_id: pickupPointId,
            starts_at: input.startsAt,
            ends_at: endsAt,
            status: input.status,
            price_cents: input.priceCents,
            notes: input.notes,
            source: "api",
          })
          .execute();
        await trx
          .insertInto("legacy_id_map")
          .values({ entity: "booking", legacy_id: legacyId, new_id: id })
          .execute();
        await trx
          .insertInto("booking_events")
          .values({
            booking_id: id,
            status: input.status,
            occurred_at: new Date(),
            actor: "api",
            source: "api",
          })
          .execute();

        const created = await bookingViews(trx).where("b.id", "=", id).executeTakeFirstOrThrow();
        return toView(created);
      }),
  };
}

async function resolve(db: Db, entity: string, legacyId: string): Promise<string | undefined> {
  const row = await db
    .selectFrom("legacy_id_map")
    .select("new_id")
    .where("entity", "=", entity)
    .where("legacy_id", "=", legacyId)
    .executeTakeFirst();
  return row?.new_id;
}

function bookingViews(db: Db) {
  return db
    .selectFrom("bookings as b")
    .innerJoin("students as s", "s.id", "b.student_id")
    .innerJoin("instructors as i", "i.id", "b.instructor_id")
    .leftJoin("pickup_points as p", "p.id", "b.pickup_point_id")
    .select([
      "b.legacy_id as id",
      "s.legacy_id as studentId",
      "i.legacy_id as instructorId",
      "p.legacy_id as pickupPointId",
      "b.starts_at as startsAt",
      "b.ends_at as endsAt",
      "b.status",
      "b.price_cents as priceCents",
      "b.paid",
      "b.notes",
      "b.deleted_at as deletedAt",
    ]);
}

type ViewRow = Awaited<ReturnType<ReturnType<typeof bookingViews>["executeTakeFirstOrThrow"]>>;

function toView(row: ViewRow): BookingView {
  return {
    id: row.id,
    studentId: row.studentId,
    instructorId: row.instructorId,
    pickupPointId: row.pickupPointId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    priceCents: row.priceCents,
    paid: row.paid,
    notes: row.notes,
    deleted: row.deletedAt !== null,
  };
}
