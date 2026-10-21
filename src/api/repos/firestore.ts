import { type BookingRow, normalizeBooking } from "../../normalize/bookings.js";
import type { NormalizeContext } from "../../normalize/context.js";
import { contextFromSource } from "../../normalize/source-context.js";
import type { DocumentStore } from "../../source/document-store.js";
import type { BookingsReader, BookingView } from "./types.js";

/**
 * Reads the source and runs every booking through the same normaliser as the migration, so
 * both read paths return the same shape. A booking the normaliser rejects (an unreadable
 * date, say) can't be shown in that shape and reads as not found.
 */
export function firestoreBookings(
  store: DocumentStore,
  timeZone: string,
  cacheMs = 30_000,
): BookingsReader {
  let cached: { at: number; context: Promise<NormalizeContext> } | undefined;
  const context = () => {
    if (!cached || Date.now() - cached.at > cacheMs) {
      cached = { at: Date.now(), context: loadContext(store, timeZone) };
    }
    return cached.context;
  };

  return {
    getByLegacyId: async (legacyId) => {
      const doc = await store.get("bookings", legacyId);
      if (!doc) return undefined;
      const result = normalizeBooking(doc, await context());
      return result.ok ? toView(result.value) : undefined;
    },

    listForInstructor: async (instructorLegacyId, from, to) => {
      const ctx = await context();
      if (!ctx.instructors(instructorLegacyId)) return undefined;
      const docs = await store.findBy("bookings", "instructorId", instructorLegacyId);
      return docs
        .flatMap((doc) => {
          const result = normalizeBooking(doc, ctx);
          return result.ok ? [result.value] : [];
        })
        .filter((row) => row.deletedAt === null && row.startsAt < to && row.endsAt > from)
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .map(toView);
    },
  };
}

async function loadContext(store: DocumentStore, timeZone: string): Promise<NormalizeContext> {
  const [cities, pickupPoints, instructors, students] = await Promise.all([
    store.all("cities"),
    store.all("pickupPoints"),
    store.all("instructors"),
    store.all("students"),
  ]);
  const { context } = contextFromSource({
    cities,
    pickupPoints,
    instructors,
    students,
    bookings: [],
  });
  return { ...context, timeZone };
}

function toView(row: BookingRow): BookingView {
  return {
    id: row.legacyId,
    studentId: row.studentLegacyId,
    instructorId: row.instructorLegacyId,
    pickupPointId: row.pickupPointLegacyId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    priceCents: row.priceCents,
    paid: row.paid,
    notes: row.notes,
    deleted: row.deletedAt !== null,
  };
}
