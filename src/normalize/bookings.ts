import type { BookingStatus } from "../db/types.js";
import type { RawDoc } from "../source/types.js";
import type { InstructorRef, NormalizeContext, StudentRef } from "./context.js";
import { parseInstant } from "./dates.js";
import { isDeleted, optionalText, requiredText, sameName, unknownFieldsWarning } from "./fields.js";
import { normalizePrice } from "./money.js";
import { type NormalizeResult, ok, reject, type Warning, warning } from "./result.js";
import { bookingRowSchema, checked, MAX_DURATION_MIN, MIN_DURATION_MIN } from "./schemas.js";
import { normalizeStatus, readStatus } from "./status.js";

export const DEFAULT_DURATION_MIN = 60;

export type BookingEvent = { status: string; occurredAt: Date; actor: string | null };

export type BookingRow = {
  legacyId: string;
  studentId: string;
  studentLegacyId: string;
  instructorId: string;
  instructorLegacyId: string;
  pickupPointId: string | null;
  pickupPointLegacyId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: BookingStatus;
  priceCents: number | null;
  paid: boolean;
  notes: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  legacyUpdatedAt: Date;
  events: BookingEvent[];
};

const KNOWN_FIELDS = new Set([
  "studentId",
  "instructorId",
  "pickupPointId",
  "startAt",
  "durationMin",
  "status",
  "price",
  "paid",
  "studentName",
  "instructorName",
  "cityName",
  "history",
  "notes",
  "deleted",
  "createdAt",
]);

/**
 * Checks run in a fixed order (references, start, duration, status, price) so each bad
 * record gets one predictable reason. Postgres keeps only the foreign keys: the copied
 * names are compared and reported, never stored.
 */
export function normalizeBooking(
  doc: RawDoc,
  context: NormalizeContext,
): NormalizeResult<BookingRow> {
  const { data } = doc;
  const studentLegacyId = requiredText(data, "studentId");
  if (!studentLegacyId.ok) return studentLegacyId;
  const student = context.students(studentLegacyId.value);
  if (!student) return reject("ORPHAN_STUDENT", `studentId ${studentLegacyId.value} not found`);

  const instructorLegacyId = requiredText(data, "instructorId");
  if (!instructorLegacyId.ok) return instructorLegacyId;
  const instructor = context.instructors(instructorLegacyId.value);
  if (!instructor)
    return reject("ORPHAN_INSTRUCTOR", `instructorId ${instructorLegacyId.value} not found`);

  const warnings: Warning[] = [];
  const pickupLegacyId = optionalText(data.pickupPointId);
  const pickupPoint = pickupLegacyId === null ? undefined : context.pickupPoints(pickupLegacyId);
  if (pickupLegacyId !== null && !pickupPoint)
    warnings.push(warning("ORPHAN_PICKUP_POINT", `pickupPointId ${pickupLegacyId}`));

  if (data.startAt === undefined || data.startAt === null)
    return reject("MISSING_REQUIRED_FIELD", "startAt is missing");
  const startsAt = parseInstant(data.startAt, "startAt", context.timeZone);
  if (!startsAt.ok) return startsAt;
  warnings.push(...startsAt.warnings);

  const duration = readDuration(data.durationMin);
  if (!duration.ok) return duration;
  warnings.push(...duration.warnings);

  const status = normalizeStatus(data.status);
  if (!status.ok) return status;
  warnings.push(...status.warnings);

  const price = normalizePrice(data.price);
  if (!price.ok) return price;
  warnings.push(...price.warnings);

  if (data.paid !== undefined && typeof data.paid !== "boolean")
    return reject("INVALID_RECORD", "paid is not true/false");

  const history = readHistory(data.history, context.timeZone);
  warnings.push(...history.warnings);
  warnings.push(...nameDrift(data, student, instructor));
  warnings.push(...unknownFieldsWarning(data, KNOWN_FIELDS));

  const createdAt = parseInstant(data.createdAt, "createdAt", context.timeZone);
  const row: BookingRow = {
    legacyId: doc.id,
    studentId: student.id,
    studentLegacyId: student.legacyId,
    instructorId: instructor.id,
    instructorLegacyId: instructor.legacyId,
    pickupPointId: pickupPoint?.id ?? null,
    pickupPointLegacyId: pickupPoint?.legacyId ?? null,
    startsAt: startsAt.value,
    endsAt: new Date(startsAt.value.getTime() + duration.value * 60_000),
    status: status.value,
    priceCents: price.value,
    paid: data.paid === true,
    notes: optionalText(data.notes),
    deletedAt: isDeleted(data) ? doc.updateTime : null,
    createdAt: createdAt.ok ? createdAt.value : doc.updateTime,
    legacyUpdatedAt: doc.updateTime,
    events: history.events,
  };
  return checked(bookingRowSchema, row, warnings);
}

function readDuration(value: unknown): NormalizeResult<number> {
  if (value === undefined || value === null) {
    return ok(DEFAULT_DURATION_MIN, [warning("DURATION_DEFAULTED", "durationMin")]);
  }
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_DURATION_MIN &&
    value <= MAX_DURATION_MIN
  ) {
    return ok(value);
  }
  return reject(
    "INVALID_DURATION",
    `durationMin must be whole minutes, ${MIN_DURATION_MIN}–${MAX_DURATION_MIN}`,
  );
}

/** Status changes become events. Entries without a readable status or time are dropped and counted. */
function readHistory(
  value: unknown,
  timeZone: string,
): { events: BookingEvent[]; warnings: Warning[] } {
  if (!Array.isArray(value)) return { events: [], warnings: [] };
  const events = new Map<string, BookingEvent>();
  let dropped = 0;
  for (const entry of value) {
    const fields =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const at = parseInstant(fields.at, "history.at", timeZone);
    const status = readStatus(fields.status) ?? optionalText(fields.status)?.toLowerCase();
    if (!at.ok || !status) {
      dropped++;
      continue;
    }
    // The same status at the same moment is one event, however often the source repeats it.
    events.set(`${status}@${at.value.getTime()}`, {
      status,
      occurredAt: at.value,
      actor: optionalText(fields.by),
    });
  }
  const warnings =
    dropped > 0 ? [warning("HISTORY_ENTRY_DROPPED", `${dropped} of ${value.length} entries`)] : [];
  return { events: [...events.values()], warnings };
}

function nameDrift(
  data: Record<string, unknown>,
  student: StudentRef,
  instructor: InstructorRef,
): Warning[] {
  const comparisons: Array<[string, unknown, string]> = [
    ["studentName", data.studentName, `${student.firstName} ${student.lastName}`],
    ["instructorName", data.instructorName, instructor.fullName],
    ["cityName", data.cityName, instructor.cityName],
  ];
  const drifted = comparisons
    .filter(([, copied, actual]) => typeof copied === "string" && !sameName(copied, actual))
    .map(([field]) => field);
  return drifted.length > 0 ? [warning("DENORM_DRIFT", drifted.join(", "))] : [];
}
