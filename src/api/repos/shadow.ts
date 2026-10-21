import type { Logger } from "pino";
import { differingFields } from "../../migrate/reconcile-compare.js";
import { compareCodeUnits } from "../../util/order.js";
import type { BookingsReader, BookingView } from "./types.js";

export type ShadowStats = {
  compared: number;
  matched: number;
  differed: number;
  errors: number;
  /** How often each field differed: the to-do list before a screen can switch to Postgres. */
  fields: Record<string, number>;
};

export function emptyShadowStats(): ShadowStats {
  return { compared: 0, matched: 0, differed: 0, errors: 0, fields: {} };
}

/**
 * Reads both stores in parallel and returns Firestore, the source of truth. Differences are
 * logged as `shadow_diff` with the legacy id and field names only, and counted, so a screen
 * can move to Postgres once its diffs stay at zero. Postgres failing never fails the request.
 */
export function shadowBookings(
  firestore: BookingsReader,
  postgres: BookingsReader,
  logger: Logger,
  stats: ShadowStats,
): BookingsReader {
  const record = (
    legacyId: string,
    primary: BookingView | undefined,
    secondary: BookingView | undefined,
  ) => {
    stats.compared++;
    const fields = viewDiff(primary, secondary);
    if (fields.length === 0) {
      stats.matched++;
      return;
    }
    stats.differed++;
    for (const field of fields) stats.fields[field] = (stats.fields[field] ?? 0) + 1;
    logger.warn({ legacyId, fields }, "shadow_diff");
  };

  const shadowFailed = (error: unknown, what: string) => {
    stats.errors++;
    logger.warn({ err: error, what }, "shadow_error");
  };

  return {
    getByLegacyId: async (legacyId) => {
      const [primary, secondary] = await Promise.allSettled([
        firestore.getByLegacyId(legacyId),
        postgres.getByLegacyId(legacyId),
      ]);
      if (primary.status === "rejected") throw primary.reason;
      if (secondary.status === "rejected") shadowFailed(secondary.reason, legacyId);
      else record(legacyId, primary.value, secondary.value);
      return primary.value;
    },

    listForInstructor: async (instructorLegacyId, from, to) => {
      const [primary, secondary] = await Promise.allSettled([
        firestore.listForInstructor(instructorLegacyId, from, to),
        postgres.listForInstructor(instructorLegacyId, from, to),
      ]);
      if (primary.status === "rejected") throw primary.reason;
      if (secondary.status === "rejected") {
        shadowFailed(secondary.reason, instructorLegacyId);
        return primary.value;
      }
      const left = new Map((primary.value ?? []).map((view) => [view.id, view]));
      const right = new Map((secondary.value ?? []).map((view) => [view.id, view]));
      for (const id of [...new Set([...left.keys(), ...right.keys()])].sort(compareCodeUnits)) {
        record(id, left.get(id), right.get(id));
      }
      return primary.value;
    },
  };
}

function viewDiff(firestore: BookingView | undefined, postgres: BookingView | undefined): string[] {
  if (!firestore && !postgres) return [];
  if (!postgres) return ["(missing in postgres)"];
  if (!firestore) return ["(missing in firestore)"];
  return differingFields(firestore, postgres);
}
