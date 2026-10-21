import { describe, expect, it } from "vitest";
import { canonicalJson, coordinate, sha256 } from "../../src/migrate/canonical.js";
import {
  compareEntity,
  differingFields,
  differingMonths,
  isClean,
  type PgEntry,
  type SourceEntry,
} from "../../src/migrate/reconcile-compare.js";

describe("canonicalJson", () => {
  it("doesn't depend on key order, at any depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("writes timestamps as UTC ISO, whatever zone they were made in", () => {
    expect(canonicalJson({ at: new Date("2026-10-21T14:30:00+02:00") })).toBe(
      '{"at":"2026-10-21T12:30:00.000Z"}',
    );
  });

  it("keeps array order, drops undefined and keeps null", () => {
    expect(canonicalJson({ list: [2, 1], gone: undefined, empty: null })).toBe(
      '{"empty":null,"list":[2,1]}',
    );
  });

  it("gives equal records equal checksums", () => {
    expect(sha256(canonicalJson({ a: 1, b: 2 }))).toBe(sha256(canonicalJson({ b: 2, a: 1 })));
  });

  it.each([
    [45.4642, "45.464200"],
    ["45.464200", "45.464200"],
    [null, null],
  ])("writes coordinate %j like numeric(9,6): %j", (value, expected) => {
    expect(coordinate(value)).toBe(expected);
  });
});

describe("differingFields", () => {
  it("names only the fields that differ", () => {
    expect(
      differingFields({ price: 4500, status: "confirmed" }, { price: 4501, status: "confirmed" }),
    ).toEqual(["price"]);
  });

  it("treats a missing field and null alike", () => {
    expect(differingFields({ notes: null }, {})).toEqual([]);
  });
});

describe("compareEntity", () => {
  const record = (price: number) => ({ priceCents: price });
  const src = (entries: Array<[string, SourceEntry]>) => new Map(entries);
  const pg = (entries: Array<[string, PgEntry]>) => new Map(entries);
  const ok = (price = 4500): SourceEntry => ({ kind: "record", record: record(price) });
  const row = (price = 4500, deleted = false): PgEntry => ({ record: record(price), deleted });

  it("is clean when both sides hold the same records", () => {
    const result = compareEntity({
      source: src([
        ["a", ok()],
        ["b", ok()],
      ]),
      sourceDocs: 2,
      mergedDuplicates: 0,
      pg: pg([
        ["a", row()],
        ["b", row()],
      ]),
      everRejected: new Set(),
    });
    expect(result).toMatchObject({ matched: 2, pgRows: 2, countsMatch: true });
    expect(isClean(result)).toBe(true);
  });

  it.each<[string, Array<[string, SourceEntry]>, Array<[string, PgEntry]>, string[], object]>([
    [
      "a doc rejected by a run is an expected gap",
      [
        ["a", ok()],
        ["b", ok()],
      ],
      [["a", row()]],
      ["b"],
      { expectedGaps: ["b"], clean: true },
    ],
    [
      "a doc never rejected is missing",
      [
        ["a", ok()],
        ["b", ok()],
      ],
      [["a", row()]],
      [],
      { missingInPg: ["b"], clean: false },
    ],
    [
      "a live row with no source doc is extra",
      [["a", ok()]],
      [
        ["a", row()],
        ["z", row()],
      ],
      [],
      { extraInPg: ["z"], clean: false },
    ],
    [
      "a soft-deleted row with no source doc was deleted in the source",
      [["a", ok()]],
      [
        ["a", row()],
        ["z", row(4500, true)],
      ],
      [],
      { deletedInSource: ["z"], clean: true },
    ],
    [
      "a changed field is a mismatch",
      [["a", ok(4500)]],
      [["a", row(4501)]],
      [],
      { mismatched: [{ legacyId: "a", fields: ["priceCents"] }], clean: false },
    ],
    [
      "a row the normaliser now rejects is a mismatch",
      [["a", { kind: "rejected", reason: "INVALID_DATE" }]],
      [["a", row()]],
      [],
      { clean: false },
    ],
  ])("classifies: %s", (_case, sourceEntries, pgEntries, rejected, expected) => {
    const result = compareEntity({
      source: src(sourceEntries),
      sourceDocs: sourceEntries.length,
      mergedDuplicates: 0,
      pg: pg(pgEntries),
      everRejected: new Set(rejected),
    });
    const { clean, ...fields } = expected as { clean: boolean };
    expect(result).toMatchObject(fields);
    expect(isClean(result)).toBe(clean);
  });

  it("counts merged duplicates in the formula firestore_docs = pg_rows + rejected + merged", () => {
    const result = compareEntity({
      source: src([["st_a", ok()]]),
      sourceDocs: 2, // st_a and st_b, merged into st_a
      mergedDuplicates: 1,
      pg: pg([["st_a", row()]]),
      everRejected: new Set(),
    });
    expect(result.countsMatch).toBe(true);
  });
});

describe("differingMonths", () => {
  it("names the months whose active count or price total differ", () => {
    const source = {
      "2026-09": { activeBookings: 3, priceCents: 13500 },
      "2026-10": { activeBookings: 1, priceCents: 4500 },
    };
    const pg = {
      "2026-09": { activeBookings: 3, priceCents: 13500 },
      "2026-10": { activeBookings: 1, priceCents: 4501 },
    };
    expect(differingMonths(source, pg)).toEqual(["2026-10"]);
  });
});
