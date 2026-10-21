import { describe, expect, it } from "vitest";
import { normalizeBooking } from "../../../src/normalize/bookings.js";
import { normalizeCity } from "../../../src/normalize/cities.js";
import { normalizeInstructor } from "../../../src/normalize/instructors.js";
import { normalizePickupPoint } from "../../../src/normalize/pickup-points.js";
import {
  mergeDuplicateStudents,
  normalizeStudent,
  type StudentCandidate,
} from "../../../src/normalize/students.js";
import { okValue, outcome, raw, testContext, UPDATE_TIME } from "../../support/normalize.js";

const context = testContext();

describe("normalizeCity", () => {
  it.each<[string, Record<string, unknown>, object]>([
    ["a complete city", { name: "Milano", region: "Lombardia" }, { ok: true, warnings: [] }],
    ["a city without a region", { name: "Milano" }, { ok: true, warnings: [] }],
    [
      "a city with extra fields",
      { name: "Milano", flag: 1 },
      { ok: true, warnings: ["UNKNOWN_FIELDS"] },
    ],
    [
      "a city without a name",
      { region: "Lombardia" },
      { ok: false, reason: "MISSING_REQUIRED_FIELD" },
    ],
  ])("handles %s", (_case, data, expected) => {
    expect(outcome(normalizeCity(raw("ct_x", data)))).toEqual(expected);
  });
});

describe("normalizePickupPoint", () => {
  const base = {
    cityId: "ct_milano",
    name: "Duomo",
    address: "Piazza del Duomo 1",
    lat: 45.4642,
    lng: 9.19,
  };

  it.each<[string, Record<string, unknown>, object]>([
    ["a complete pickup point", base, { ok: true, warnings: [] }],
    ["one without coordinates", { cityId: "ct_milano", name: "Duomo" }, { ok: true, warnings: [] }],
    [
      "one with an impossible latitude",
      { ...base, lat: 123 },
      { ok: true, warnings: ["COORDINATES_INVALID"] },
    ],
    [
      "one with only a latitude",
      { ...base, lng: undefined },
      { ok: true, warnings: ["COORDINATES_INVALID"] },
    ],
    [
      "one in an unknown city",
      { ...base, cityId: "ct_nowhere" },
      { ok: false, reason: "ORPHAN_CITY" },
    ],
    [
      "one without a city",
      { ...base, cityId: undefined },
      { ok: false, reason: "MISSING_REQUIRED_FIELD" },
    ],
  ])("handles %s", (_case, data, expected) => {
    expect(outcome(normalizePickupPoint(raw("pp_x", data), context))).toEqual(expected);
  });

  it("drops both coordinates when one is wrong", () => {
    const row = okValue(normalizePickupPoint(raw("pp_x", { ...base, lat: 123 }), context));
    expect([row.lat, row.lng]).toEqual([null, null]);
  });
});

describe("normalizeInstructor", () => {
  const base = {
    fullName: "Sara Ricci",
    cityId: "ct_milano",
    phone: "+393401112233",
    licenseCategories: ["B"],
  };

  it.each<[string, Record<string, unknown>, object]>([
    ["a complete instructor", base, { ok: true, warnings: [] }],
    [
      "one with a local phone",
      { ...base, phone: "340 111 2233" },
      { ok: true, warnings: ["PHONE_NORMALIZED"] },
    ],
    [
      "one with an unknown category",
      { ...base, licenseCategories: ["B", "Z"] },
      { ok: true, warnings: ["LICENSE_CATEGORY_INVALID"] },
    ],
    [
      "one in an unknown city",
      { ...base, cityId: "ct_nowhere" },
      { ok: false, reason: "ORPHAN_CITY" },
    ],
    [
      "one without a name",
      { ...base, fullName: " " },
      { ok: false, reason: "MISSING_REQUIRED_FIELD" },
    ],
  ])("handles %s", (_case, data, expected) => {
    expect(outcome(normalizeInstructor(raw("in_x", data), context))).toEqual(expected);
  });

  it("keeps known categories, upper-cased, and defaults active to true", () => {
    const row = okValue(
      normalizeInstructor(raw("in_x", { ...base, licenseCategories: ["b", "a2", "Z"] }), context),
    );
    expect(row.licenseCategories).toEqual(["B", "A2"]);
    expect(row.active).toBe(true);
  });
});

describe("normalizeStudent", () => {
  const base = {
    firstName: "Mario",
    lastName: "Rossi",
    email: "mario.rossi@example.com",
    phone: "+393471112233",
    taxCode: "RSSMRA85M01F205Z",
    cityId: "ct_milano",
    licenseCategory: "B",
    createdAt: new Date("2026-03-01T10:00:00Z"),
  };

  it.each<[string, Record<string, unknown>, object]>([
    ["a complete student", base, { ok: true, warnings: [] }],
    [
      "one whose phone is a note",
      { ...base, phone: "chiamami dopo le 18" },
      { ok: true, warnings: ["PHONE_UNPARSEABLE"] },
    ],
    [
      "one with a malformed tax code",
      { ...base, taxCode: "RSSMRA85" },
      { ok: true, warnings: ["TAX_CODE_INVALID"] },
    ],
    [
      "one with a tax code in lower case and spaces",
      { ...base, taxCode: "rssmra 85m01 f205z" },
      { ok: true, warnings: [] },
    ],
    [
      "one with an unknown category",
      { ...base, licenseCategory: "C" },
      { ok: true, warnings: ["LICENSE_CATEGORY_INVALID"] },
    ],
    [
      "one in an unknown city",
      { ...base, cityId: "ct_nowhere" },
      { ok: true, warnings: ["CITY_UNKNOWN"] },
    ],
    [
      "one without a last name",
      { ...base, lastName: undefined },
      { ok: false, reason: "MISSING_REQUIRED_FIELD" },
    ],
  ])("handles %s", (_case, data, expected) => {
    expect(outcome(normalizeStudent(raw("st_x", data), context))).toEqual(expected);
  });

  it("marks a deleted student with the source's last update time", () => {
    const row = okValue(normalizeStudent(raw("st_x", { ...base, deleted: true }), context));
    expect(row.deletedAt).toEqual(UPDATE_TIME);
  });
});

describe("mergeDuplicateStudents", () => {
  const candidate = (legacyId: string, overrides: Partial<StudentCandidate>): StudentCandidate => ({
    legacyId,
    cityId: "uuid-ct_milano",
    cityLegacyId: "ct_milano",
    firstName: "Mario",
    lastName: "Rossi",
    email: "mario.rossi@example.com",
    emailKey: "mario.rossi@example.com",
    phoneE164: null,
    taxCode: null,
    licenseCategory: "B",
    deletedAt: null,
    createdAt: new Date("2026-03-01T10:00:00Z"),
    legacyUpdatedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  });

  it("keeps the oldest sign-up and fills its gaps from the newer one", () => {
    const older = candidate("st_b", { email: "Mario.Rossi@Example.com" });
    const newer = candidate("st_a", {
      createdAt: new Date("2026-05-10T10:00:00Z"),
      phoneE164: "+393471112233",
      taxCode: "RSSMRA85M01F205Z",
      legacyUpdatedAt: new Date("2026-10-02T00:00:00Z"),
    });
    const { students, duplicates } = mergeDuplicateStudents([newer, older]);

    expect(students).toHaveLength(1);
    expect(students[0]).toMatchObject({
      legacyId: "st_b",
      legacyIds: ["st_a", "st_b"],
      email: "Mario.Rossi@Example.com",
      phoneE164: "+393471112233",
      taxCode: "RSSMRA85M01F205Z",
      legacyUpdatedAt: new Date("2026-10-02T00:00:00Z"),
    });
    expect(duplicates).toEqual([{ legacyId: "st_a", mergedInto: "st_b" }]);
  });

  it("breaks a tie on sign-up time by doc id", () => {
    const { students } = mergeDuplicateStudents([candidate("st_b", {}), candidate("st_a", {})]);
    expect(students[0]?.legacyId).toBe("st_a");
  });

  it.each<[string, Partial<StudentCandidate>]>([
    ["is deleted", { deletedAt: new Date("2026-09-01T00:00:00Z") }],
    ["has no email", { email: null, emailKey: null }],
    ["has a different email", { email: "other@example.com", emailKey: "other@example.com" }],
  ])("doesn't merge a second doc that %s", (_case, overrides) => {
    const { students, duplicates } = mergeDuplicateStudents([
      candidate("st_a", {}),
      candidate("st_b", overrides),
    ]);
    expect(students).toHaveLength(2);
    expect(duplicates).toEqual([]);
  });
});

describe("normalizeBooking", () => {
  const base = {
    studentId: "st_a",
    instructorId: "in_1",
    pickupPointId: "pp_duomo",
    startAt: new Date("2026-09-15T08:00:00Z"),
    durationMin: 60,
    status: "confirmed",
    price: 45,
    paid: false,
    studentName: "Mario Rossi",
    instructorName: "Sara Ricci",
    cityName: "Milano",
    history: [{ status: "booked", at: new Date("2026-09-01T08:00:00Z"), by: "app" }],
    createdAt: new Date("2026-09-01T08:00:00Z"),
  };

  it.each<[string, Record<string, unknown>, object]>([
    ["a clean booking", base, { ok: true, warnings: [] }],
    [
      "one for an unknown student",
      { ...base, studentId: "st_nobody" },
      { ok: false, reason: "ORPHAN_STUDENT" },
    ],
    [
      "one for an unknown instructor",
      { ...base, instructorId: "in_nobody" },
      { ok: false, reason: "ORPHAN_INSTRUCTOR" },
    ],
    [
      "one at an unknown pickup point",
      { ...base, pickupPointId: "pp_gone" },
      { ok: true, warnings: ["ORPHAN_PICKUP_POINT"] },
    ],
    [
      "one without a start",
      { ...base, startAt: undefined },
      { ok: false, reason: "MISSING_REQUIRED_FIELD" },
    ],
    [
      "one without a duration",
      { ...base, durationMin: undefined },
      { ok: true, warnings: ["DURATION_DEFAULTED"] },
    ],
    [
      "one lasting 600 minutes",
      { ...base, durationMin: 600 },
      { ok: false, reason: "INVALID_DURATION" },
    ],
    [
      "one lasting 10 minutes",
      { ...base, durationMin: 10 },
      { ok: false, reason: "INVALID_DURATION" },
    ],
    [
      'one lasting "60" minutes',
      { ...base, durationMin: "60" },
      { ok: false, reason: "INVALID_DURATION" },
    ],
    [
      "one without a price",
      { ...base, price: undefined },
      { ok: true, warnings: ["PRICE_MISSING"] },
    ],
    ["one with a negative price", { ...base, price: -1 }, { ok: false, reason: "INVALID_PRICE" }],
    ["one with paid as text", { ...base, paid: "yes" }, { ok: false, reason: "INVALID_RECORD" }],
    [
      "one whose copied names drifted",
      { ...base, studentName: "Mario R.", cityName: "Roma" },
      { ok: true, warnings: ["DENORM_DRIFT"] },
    ],
    [
      "one whose names differ only in spacing and case",
      { ...base, studentName: " mario  ROSSI " },
      { ok: true, warnings: [] },
    ],
    [
      "one with an unreadable history entry",
      { ...base, history: [{ status: "booked" }] },
      { ok: true, warnings: ["HISTORY_ENTRY_DROPPED"] },
    ],
  ])("handles %s", (_case, data, expected) => {
    expect(outcome(normalizeBooking(raw("bk_x", data), context))).toEqual(expected);
  });

  it("resolves a merged duplicate to the surviving student", () => {
    const row = okValue(normalizeBooking(raw("bk_x", { ...base, studentId: "st_b" }), context));
    expect([row.studentId, row.studentLegacyId]).toEqual(["uuid-st_a", "st_a"]);
  });

  it("computes the end from the duration and keeps the history as events", () => {
    const row = okValue(normalizeBooking(raw("bk_x", { ...base, durationMin: 90 }), context));
    expect(row.endsAt.toISOString()).toBe("2026-09-15T09:30:00.000Z");
    expect(row.events).toEqual([
      { status: "booked", occurredAt: new Date("2026-09-01T08:00:00Z"), actor: "app" },
    ]);
  });

  it("collapses a history entry repeated at the same moment", () => {
    const entry = { status: "booked", at: new Date("2026-09-01T08:00:00Z"), by: "app" };
    const row = okValue(
      normalizeBooking(raw("bk_x", { ...base, history: [entry, entry] }), context),
    );
    expect(row.events).toHaveLength(1);
  });

  it("names the drifted fields, never their values", () => {
    const result = normalizeBooking(raw("bk_x", { ...base, studentName: "Mario R." }), context);
    expect(result.ok && result.warnings).toEqual([{ code: "DENORM_DRIFT", detail: "studentName" }]);
  });
});
