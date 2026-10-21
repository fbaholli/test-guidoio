import { z } from "zod";
import type { CollectionName } from "../source/collections.js";

export type EntityStats = {
  read: number;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: Record<string, number>;
  warnings: Record<string, number>;
  events: number;
};

export type RunStats = Partial<Record<CollectionName, EntityStats>>;

const entityStatsSchema = z.object({
  read: z.number(),
  inserted: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  rejected: z.record(z.string(), z.number()),
  warnings: z.record(z.string(), z.number()),
  events: z.number(),
});

/** Stats saved on the run row, read back when a crashed run is resumed. */
export const runStatsSchema = z.partialRecord(
  z.enum(["cities", "pickupPoints", "instructors", "students", "bookings"]),
  entityStatsSchema,
);

/** Singular entity names, as stored in migration_rejects, migration_warnings and legacy_id_map. */
export const ENTITY_BY_COLLECTION: Record<CollectionName, string> = {
  cities: "city",
  pickupPoints: "pickup_point",
  instructors: "instructor",
  students: "student",
  bookings: "booking",
};

export function statsFor(stats: RunStats, collection: CollectionName): EntityStats {
  const existing = stats[collection];
  if (existing) return existing;
  const fresh: EntityStats = {
    read: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    rejected: {},
    warnings: {},
    events: 0,
  };
  stats[collection] = fresh;
  return fresh;
}

export function count(counter: Record<string, number>, code: string, by = 1): void {
  counter[code] = (counter[code] ?? 0) + by;
}

export function total(counter: Record<string, number>): number {
  return Object.values(counter).reduce((sum, value) => sum + value, 0);
}
