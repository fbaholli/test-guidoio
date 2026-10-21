import { compareCodeUnits } from "../util/order.js";
import { type CanonicalRecord, canonicalJson, sha256 } from "./canonical.js";

// The pure half of reconciliation: given both sides as canonical records, classify every
// legacy id. Output names legacy ids and field names only.

export type SourceEntry =
  | { kind: "record"; record: CanonicalRecord }
  /** The normaliser rejects this doc today, so it should not be in Postgres. */
  | { kind: "rejected"; reason: string };

export type PgEntry = { record: CanonicalRecord; deleted: boolean };

export type Mismatch = { legacyId: string; fields: string[] };

export type EntityComparison = {
  sourceDocs: number;
  mergedDuplicates: number;
  pgRows: number;
  matched: number;
  /** Not in Postgres, but rejected by some run: expected, counted, not a failure. */
  expectedGaps: string[];
  missingInPg: string[];
  extraInPg: string[];
  /** Soft-deleted in Postgres and gone from the source: picked up by sync, not a failure. */
  deletedInSource: string[];
  mismatched: Mismatch[];
  /** firestore_docs = pg_rows + rejected + merged_duplicates */
  countsMatch: boolean;
};

export function compareEntity(input: {
  source: ReadonlyMap<string, SourceEntry>;
  sourceDocs: number;
  mergedDuplicates: number;
  pg: ReadonlyMap<string, PgEntry>;
  everRejected: ReadonlySet<string>;
}): EntityComparison {
  const { source, pg, everRejected } = input;
  const result: EntityComparison = {
    sourceDocs: input.sourceDocs,
    mergedDuplicates: input.mergedDuplicates,
    pgRows: 0,
    matched: 0,
    expectedGaps: [],
    missingInPg: [],
    extraInPg: [],
    deletedInSource: [],
    mismatched: [],
    countsMatch: false,
  };

  for (const [legacyId, entry] of source) {
    const row = pg.get(legacyId);
    if (!row) {
      if (everRejected.has(legacyId)) result.expectedGaps.push(legacyId);
      else result.missingInPg.push(legacyId);
      continue;
    }
    if (entry.kind === "rejected") {
      result.mismatched.push({
        legacyId,
        fields: [`(the source doc is now rejected: ${entry.reason})`],
      });
      continue;
    }
    const fields = differingFields(entry.record, row.record);
    if (fields.length === 0) result.matched++;
    else result.mismatched.push({ legacyId, fields });
  }

  for (const [legacyId, row] of pg) {
    if (source.has(legacyId)) continue;
    if (row.deleted) result.deletedInSource.push(legacyId);
    else result.extraInPg.push(legacyId);
  }

  result.pgRows = pg.size - result.deletedInSource.length;
  result.countsMatch =
    result.sourceDocs === result.pgRows + result.expectedGaps.length + result.mergedDuplicates;
  for (const list of [
    result.expectedGaps,
    result.missingInPg,
    result.extraInPg,
    result.deletedInSource,
  ]) {
    list.sort(compareCodeUnits);
  }
  result.mismatched.sort((a, b) => compareCodeUnits(a.legacyId, b.legacyId));
  return result;
}

/** Field names whose canonical values differ; checksums first, so equal records cost one hash. */
export function differingFields(a: CanonicalRecord, b: CanonicalRecord): string[] {
  if (sha256(canonicalJson(a)) === sha256(canonicalJson(b))) return [];
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...fields]
    .filter((field) => canonicalJson(a[field] ?? null) !== canonicalJson(b[field] ?? null))
    .sort(compareCodeUnits);
}

export function isClean(comparison: EntityComparison): boolean {
  return (
    comparison.missingInPg.length === 0 &&
    comparison.extraInPg.length === 0 &&
    comparison.mismatched.length === 0 &&
    comparison.countsMatch
  );
}

export type MonthTotals = Record<string, { activeBookings: number; priceCents: number }>;

/** Months whose active-booking count or price sum differ between the two sides. */
export function differingMonths(source: MonthTotals, pg: MonthTotals): string[] {
  const months = new Set([...Object.keys(source), ...Object.keys(pg)]);
  return [...months]
    .filter((month) => canonicalJson(source[month] ?? null) !== canonicalJson(pg[month] ?? null))
    .sort(compareCodeUnits);
}
