import { COLLECTIONS } from "../source/collections.js";
import { compareCodeUnits } from "../util/order.js";
import { SNAPSHOT, utcIso } from "./calendar.js";
import { FIXTURE_BOOKINGS, FIXTURE_INSTRUCTORS, FIXTURE_STUDENTS } from "./fixtures.js";
import { generateNormalData } from "./generate.js";
import { cityDocs, pickupPointDocs } from "./reference-data.js";
import type { SeedDataset, SeedDoc } from "./types.js";

/** The `_updateTime` the JSON export gives every doc: the moment the dataset was "taken". */
export const EXPORT_UPDATE_TIME = utcIso(SNAPSHOT);

/** The full seed: generated normal data plus the known-bad fixtures, each collection in id order. */
export function buildSeedDataset(): SeedDataset {
  const generated = generateNormalData();
  const dataset: SeedDataset = {
    cities: sortById(cityDocs()),
    pickupPoints: sortById(pickupPointDocs()),
    instructors: sortById([...generated.instructors, ...FIXTURE_INSTRUCTORS]),
    students: sortById([...generated.students, ...FIXTURE_STUDENTS]),
    bookings: sortById([...generated.bookings, ...FIXTURE_BOOKINGS]),
  };
  assertUniqueIds(dataset);
  return dataset;
}

// Firestore returns documents in id order, so the export lists them the same way.
function sortById(docs: readonly SeedDoc[]): SeedDoc[] {
  return [...docs].sort((a, b) => compareCodeUnits(a.id, b.id));
}

function assertUniqueIds(dataset: SeedDataset): void {
  for (const collection of COLLECTIONS) {
    const seen = new Set<string>();
    for (const { id } of dataset[collection]) {
      if (seen.has(id)) throw new Error(`Duplicate id ${id} in ${collection}`);
      seen.add(id);
    }
  }
}
