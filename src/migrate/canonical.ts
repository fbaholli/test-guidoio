import { createHash } from "node:crypto";
import type { BookingRow } from "../normalize/bookings.js";
import type { CityRow } from "../normalize/cities.js";
import type { InstructorRow } from "../normalize/instructors.js";
import type { PickupPointRow } from "../normalize/pickup-points.js";
import type { MergedStudent } from "../normalize/students.js";
import { compareCodeUnits } from "../util/order.js";

// One canonical form for a record, whichever side it comes from: references as legacy ids
// (the surviving id for a merged student), timestamps as UTC ISO strings, money in cents,
// coordinates to 6 decimals like numeric(9,6). Bookkeeping columns are left out.

export type CanonicalRecord = Record<string, unknown>;

/** JSON with keys sorted at every level, so equal data always gives equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([k, v]) => [k, sortKeys(v)]),
  );
}

export function coordinate(value: number | string | null): string | null {
  return value === null ? null : Number(value).toFixed(6);
}

export function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export type CanonicalEvent = { status: string; occurredAt: string; actor: string | null };

export function sortEvents(events: CanonicalEvent[]): CanonicalEvent[] {
  return [...events].sort(
    (a, b) => compareCodeUnits(a.occurredAt, b.occurredAt) || compareCodeUnits(a.status, b.status),
  );
}

export const fromSource = {
  city: (row: CityRow): CanonicalRecord => ({ name: row.name, region: row.region }),
  pickupPoint: (row: PickupPointRow): CanonicalRecord => ({
    city: row.cityLegacyId,
    name: row.name,
    address: row.address,
    lat: coordinate(row.lat),
    lng: coordinate(row.lng),
  }),
  instructor: (row: InstructorRow): CanonicalRecord => ({
    city: row.cityLegacyId,
    fullName: row.fullName,
    email: row.email,
    phoneE164: row.phoneE164,
    licenseCategories: row.licenseCategories,
    active: row.active,
  }),
  student: (row: MergedStudent): CanonicalRecord => ({
    legacyIds: [...row.legacyIds].sort(compareCodeUnits),
    city: row.cityLegacyId,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phoneE164: row.phoneE164,
    taxCode: row.taxCode,
    licenseCategory: row.licenseCategory,
    deleted: row.deletedAt !== null,
    createdAt: iso(row.createdAt),
  }),
  booking: (row: BookingRow): CanonicalRecord => ({
    student: row.studentLegacyId,
    instructor: row.instructorLegacyId,
    pickupPoint: row.pickupPointLegacyId,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    status: row.status,
    priceCents: row.priceCents,
    paid: row.paid,
    notes: row.notes,
    deleted: row.deletedAt !== null,
    createdAt: iso(row.createdAt),
    events: sortEvents(
      row.events.map((e) => ({
        status: e.status,
        occurredAt: e.occurredAt.toISOString(),
        actor: e.actor,
      })),
    ),
  }),
};
