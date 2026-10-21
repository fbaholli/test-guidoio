import { z } from "zod";
import { type NormalizeResult, ok, reject, type Warning } from "./result.js";

// Strict shapes of what the normalisers hand to the database. Each normaliser checks its
// output against one of these as a last safety net: a mistake in a rule becomes a reject
// (INVALID_RECORD, naming the field paths) instead of a constraint error mid-batch.

export const LICENSE_CATEGORIES = ["AM", "A1", "A2", "A", "B"] as const;
export const BOOKING_STATUSES = [
  "booked",
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
] as const;
export const MIN_DURATION_MIN = 15;
export const MAX_DURATION_MIN = 240;

const text = z.string().min(1);
const e164 = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
const common = { legacyId: text, createdAt: z.date(), legacyUpdatedAt: z.date() };

export const cityRowSchema = z.strictObject({
  ...common,
  name: text,
  region: text.nullable(),
});

export const pickupPointRowSchema = z.strictObject({
  ...common,
  cityId: text,
  cityLegacyId: text,
  name: text,
  address: text.nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
});

export const instructorRowSchema = z.strictObject({
  ...common,
  cityId: text,
  cityLegacyId: text,
  fullName: text,
  email: text.nullable(),
  phoneE164: e164.nullable(),
  licenseCategories: z.array(z.enum(LICENSE_CATEGORIES)),
  active: z.boolean(),
});

export const studentRowSchema = z.strictObject({
  ...common,
  cityId: text.nullable(),
  cityLegacyId: text.nullable(),
  firstName: text,
  lastName: text,
  email: text.nullable(),
  emailKey: text.nullable(),
  phoneE164: e164.nullable(),
  taxCode: z
    .string()
    .regex(/^[A-Z0-9]{16}$/)
    .nullable(),
  licenseCategory: z.enum(LICENSE_CATEGORIES).nullable(),
  deletedAt: z.date().nullable(),
});

export const bookingRowSchema = z
  .strictObject({
    ...common,
    studentId: text,
    studentLegacyId: text,
    instructorId: text,
    instructorLegacyId: text,
    pickupPointId: text.nullable(),
    pickupPointLegacyId: text.nullable(),
    startsAt: z.date(),
    endsAt: z.date(),
    status: z.enum(BOOKING_STATUSES),
    priceCents: z.number().int().min(0).nullable(),
    paid: z.boolean(),
    notes: text.nullable(),
    deletedAt: z.date().nullable(),
    events: z.array(z.strictObject({ status: text, occurredAt: z.date(), actor: text.nullable() })),
  })
  .refine((row) => {
    const minutes = (row.endsAt.getTime() - row.startsAt.getTime()) / 60_000;
    return minutes >= MIN_DURATION_MIN && minutes <= MAX_DURATION_MIN;
  }, "the lesson length is outside 15–240 minutes");

export function checked<T>(schema: z.ZodType<T>, row: T, warnings: Warning[]): NormalizeResult<T> {
  const result = schema.safeParse(row);
  if (result.success) return ok(row, warnings);
  const fields = result.error.issues.map((issue) => issue.path.join(".") || "(record)");
  return reject(
    "INVALID_RECORD",
    `failed the target schema at: ${[...new Set(fields)].join(", ")}`,
  );
}
