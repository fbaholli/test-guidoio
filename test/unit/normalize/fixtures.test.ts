import { describe, expect, it } from "vitest";
import { normalizeBooking } from "../../../src/normalize/bookings.js";
import { normalizeCity } from "../../../src/normalize/cities.js";
import { normalizeInstructor } from "../../../src/normalize/instructors.js";
import { normalizePickupPoint } from "../../../src/normalize/pickup-points.js";
import { contextFromSource } from "../../../src/normalize/source-context.js";
import { normalizeStudent } from "../../../src/normalize/students.js";
import { buildSeedDataset, EXPORT_UPDATE_TIME } from "../../../src/seed/dataset.js";
import { toExportJson } from "../../../src/seed/json-export.js";
import { COLLECTIONS } from "../../../src/source/collections.js";
import { decodeExportDoc, exportFileSchema } from "../../../src/source/export-format.js";
import type { RawDoc } from "../../../src/source/types.js";
import { okValue, outcome } from "../../support/normalize.js";

// The real path: seed → JSON export → decode → normalise, exactly what the backfill will read.
const exported = exportFileSchema.parse(
  JSON.parse(toExportJson(buildSeedDataset(), EXPORT_UPDATE_TIME)),
);
const docs = Object.fromEntries(
  COLLECTIONS.map((name) => [name, exported.collections[name].map(decodeExportDoc)]),
) as Record<(typeof COLLECTIONS)[number], RawDoc[]>;
const { context, merge } = contextFromSource(docs);
const doc = (collection: (typeof COLLECTIONS)[number], id: string) => {
  const found = docs[collection].find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No ${collection} doc ${id}`);
  return found;
};
const booking = (id: string) => normalizeBooking(doc("bookings", id), context);

describe("every §3.2 booking fixture, at the normaliser", () => {
  // Overlaps are decided by Postgres in the backfill, so here those bookings are still fine.
  it.each<[string, object]>([
    ["bk_orphan_student", { ok: false, reason: "ORPHAN_STUDENT" }],
    ["bk_orphan_instructor", { ok: false, reason: "ORPHAN_INSTRUCTOR" }],
    ["bk_overlap_a", { ok: true, warnings: [] }],
    ["bk_overlap_b", { ok: true, warnings: [] }],
    ["bk_overlap_cancelled", { ok: true, warnings: [] }],
    ["bk_adjacent_1", { ok: true, warnings: [] }],
    ["bk_adjacent_2", { ok: true, warnings: [] }],
    ["bk_student_base", { ok: true, warnings: [] }],
    ["bk_student_overlap", { ok: true, warnings: [] }],
    ["bk_date_timestamp", { ok: true, warnings: [] }],
    ["bk_date_iso", { ok: true, warnings: [] }],
    ["bk_date_it_string", { ok: true, warnings: ["DATE_PARSED_FROM_STRING"] }],
    ["bk_date_epoch", { ok: true, warnings: ["DATE_PARSED_FROM_NUMBER"] }],
    ["bk_date_garbage", { ok: false, reason: "INVALID_DATE" }],
    ["bk_dst_gap", { ok: false, reason: "DST_GAP" }],
    ["bk_dst_ambiguous", { ok: true, warnings: ["DATE_PARSED_FROM_STRING", "DATE_AMBIGUOUS"] }],
    ["bk_status_variants_1", { ok: true, warnings: ["STATUS_NORMALIZED"] }],
    ["bk_status_variants_2", { ok: true, warnings: ["STATUS_NORMALIZED"] }],
    ["bk_status_variants_3", { ok: true, warnings: ["STATUS_NORMALIZED"] }],
    ["bk_status_variants_4", { ok: true, warnings: ["STATUS_NORMALIZED"] }],
    ["bk_status_unknown", { ok: false, reason: "INVALID_STATUS" }],
    ["bk_no_duration", { ok: true, warnings: ["DURATION_DEFAULTED"] }],
    ["bk_bad_duration", { ok: false, reason: "INVALID_DURATION" }],
    ["bk_price_string", { ok: true, warnings: ["PRICE_PARSED_FROM_STRING"] }],
    ["bk_denorm_drift", { ok: true, warnings: ["DENORM_DRIFT"] }],
    ["bk_dup_student_ref", { ok: true, warnings: [] }],
    ["bk_history_nested", { ok: true, warnings: [] }],
    ["bk_deleted", { ok: true, warnings: [] }],
    ["bk_unknown_fields", { ok: true, warnings: ["UNKNOWN_FIELDS"] }],
  ])("%s", (id, expected) => {
    expect(outcome(booking(id))).toEqual(expected);
  });

  it.each([
    ["bk_date_timestamp", "2026-10-21T12:30:00.000Z"],
    ["bk_date_iso", "2026-10-21T12:30:00.000Z"],
    ["bk_date_it_string", "2026-10-21T12:30:00.000Z"],
    ["bk_date_epoch", "2026-10-21T12:30:00.000Z"],
    ["bk_dst_ambiguous", "2026-10-25T00:30:00.000Z"],
  ])("starts %s at %s", (id, iso) => {
    expect(okValue(booking(id)).startsAt.toISOString()).toBe(iso);
  });

  it.each([
    ["bk_status_variants_1", "cancelled"],
    ["bk_status_variants_2", "cancelled"],
    ["bk_status_variants_3", "confirmed"],
    ["bk_status_variants_4", "no_show"],
  ])("maps %s to %s", (id, status) => {
    expect(okValue(booking(id)).status).toBe(status);
  });

  it("defaults bk_no_duration to 60 minutes", () => {
    const row = okValue(booking("bk_no_duration"));
    expect((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000).toBe(60);
  });

  it("reads bk_price_string as 4550 cents", () => {
    expect(okValue(booking("bk_price_string")).priceCents).toBe(4550);
  });

  it("resolves bk_dup_student_ref to the merged Rossi", () => {
    expect(okValue(booking("bk_dup_student_ref")).studentLegacyId).toBe("st_dup_rossi_a");
  });

  it("turns bk_history_nested into three events", () => {
    expect(okValue(booking("bk_history_nested")).events.map((event) => event.status)).toEqual([
      "booked",
      "confirmed",
      "completed",
    ]);
  });

  it("marks bk_deleted as deleted", () => {
    expect(okValue(booking("bk_deleted")).deletedAt).not.toBeNull();
  });

  it("explains why bk_status_unknown needs a decision", () => {
    const result = booking("bk_status_unknown");
    expect(result.ok ? "" : result.detail).toContain("needs a product decision");
  });

  it("lists the unknown fields of bk_unknown_fields", () => {
    const result = booking("bk_unknown_fields");
    expect(result.ok && result.warnings).toEqual([
      { code: "UNKNOWN_FIELDS", detail: "legacyFlag, tmp2" },
    ]);
  });
});

describe("every §3.2 student fixture, at the normaliser", () => {
  const student = (id: string) => normalizeStudent(doc("students", id), context);

  it.each<[string, string | null, string[]]>([
    ["st_bad_phone", null, ["PHONE_UNPARSEABLE"]],
    ["st_phone_formats_1", "+393331234567", ["PHONE_NORMALIZED"]],
    ["st_phone_formats_2", "+393331234567", ["PHONE_NORMALIZED"]],
    ["st_phone_formats_3", "+393331234567", []],
  ])("reads the phone of %s as %s", (id, e164, warnings) => {
    expect(outcome(student(id))).toEqual({ ok: true, warnings });
    expect(okValue(student(id)).phoneE164).toBe(e164);
  });

  it("merges the two Rossi sign-ups into the older one, filling its gaps", () => {
    const rossi = merge.students.find((s) => s.legacyIds.includes("st_dup_rossi_b"));
    expect(rossi).toMatchObject({
      legacyId: "st_dup_rossi_a",
      legacyIds: ["st_dup_rossi_a", "st_dup_rossi_b"],
      email: "Mario.Rossi@Example.com",
      phoneE164: "+393471112233",
      taxCode: "RSSMRA85M01F205Z",
    });
    expect(merge.duplicates).toContainEqual({
      legacyId: "st_dup_rossi_b",
      mergedInto: "st_dup_rossi_a",
    });
  });
});

describe("the generated, mostly clean data", () => {
  const generated = (id: string) => /^(ct|pp)_|^in_\d{3}$|^st_\d{4}$|^bk_\d{5}$/.test(id);
  const results = [
    ...docs.cities.filter((d) => generated(d.id)).map((d) => [d.id, normalizeCity(d)] as const),
    ...docs.pickupPoints
      .filter((d) => generated(d.id))
      .map((d) => [d.id, normalizePickupPoint(d, context)] as const),
    ...docs.instructors
      .filter((d) => generated(d.id))
      .map((d) => [d.id, normalizeInstructor(d, context)] as const),
    ...docs.students
      .filter((d) => generated(d.id))
      .map((d) => [d.id, normalizeStudent(d, context)] as const),
    ...docs.bookings
      .filter((d) => generated(d.id))
      .map((d) => [d.id, normalizeBooking(d, context)] as const),
  ];

  it("normalises without a single reject or warning", () => {
    const noisy = results
      .filter(([, result]) => !result.ok || result.warnings.length > 0)
      .map(([id]) => id);
    expect(noisy).toEqual([]);
    expect(results.length).toBeGreaterThan(2400);
  });

  it("merges exactly the 9 planned duplicate sign-ups, plus the Rossi pair", () => {
    expect(merge.duplicates).toHaveLength(10);
  });
});
