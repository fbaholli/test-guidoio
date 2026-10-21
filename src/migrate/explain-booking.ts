import type pg from "pg";
import { z } from "zod";
import { type PgError, SQLSTATE } from "../db/errors.js";
import type { BookingRow } from "../normalize/bookings.js";
import { explainGeneric, type RowFailure } from "./write-rows.js";

const OVERLAP_BY_CONSTRAINT = {
  bookings_no_instructor_overlap: {
    reason: "OVERLAP_INSTRUCTOR",
    column: "instructor_id",
    who: "instructor",
  },
  bookings_no_student_overlap: { reason: "OVERLAP_STUDENT", column: "student_id", who: "student" },
} as const;

const ORPHAN_BY_CONSTRAINT: Record<string, RowFailure["reason"]> = {
  bookings_student_id_fkey: "ORPHAN_STUDENT",
  bookings_instructor_id_fkey: "ORPHAN_INSTRUCTOR",
};

/**
 * Turns a constraint error on one booking into a reject. For an overlap it names the booking
 * already holding the slot, so ops can resolve it from the rejects report.
 */
export async function explainBookingFailure(
  client: pg.ClientBase,
  row: BookingRow,
  error: PgError,
): Promise<RowFailure> {
  if (
    error.code === SQLSTATE.exclusionViolation &&
    error.constraint &&
    error.constraint in OVERLAP_BY_CONSTRAINT
  ) {
    const overlap = OVERLAP_BY_CONSTRAINT[error.constraint as keyof typeof OVERLAP_BY_CONSTRAINT];
    const holder = await findHolder(client, overlap.column, row);
    return {
      reason: overlap.reason,
      detail: holder
        ? `overlaps ${holder} (same ${overlap.who})`
        : `overlaps an active lesson (same ${overlap.who})`,
    };
  }
  if (error.code === SQLSTATE.foreignKeyViolation && error.constraint) {
    const reason = ORPHAN_BY_CONSTRAINT[error.constraint];
    if (reason) return { reason, detail: `violates ${error.constraint}` };
  }
  return explainGeneric(row, error);
}

async function findHolder(
  client: pg.ClientBase,
  column: "instructor_id" | "student_id",
  row: BookingRow,
): Promise<string | undefined> {
  const { rows } = await client.query(
    `select legacy_id from bookings
     where ${column} = $1 and legacy_id <> $2 and deleted_at is null and status in ('booked', 'confirmed')
       and tstzrange(starts_at, ends_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
     order by legacy_id limit 1`,
    [
      column === "instructor_id" ? row.instructorId : row.studentId,
      row.legacyId,
      row.startsAt,
      row.endsAt,
    ],
  );
  return z.array(z.object({ legacy_id: z.string() })).parse(rows)[0]?.legacy_id;
}
