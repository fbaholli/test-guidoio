import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { ROME } from "../../src/seed/calendar.js";
import { buildSeedDataset } from "../../src/seed/dataset.js";
import type { SeedDoc } from "../../src/seed/types.js";
import { compareCodeUnits } from "../../src/util/order.js";
import {
  docById,
  instant,
  lessonRange,
  normalisedEmail,
  overlaps,
  text,
} from "../support/seed-fields.js";

const dataset = buildSeedDataset();
const booking = (id: string) => docById(dataset.bookings, id);
const student = (id: string) => docById(dataset.students, id);

// Every id named in MASTER_PLAN.md §3.2.
const FIXTURE_BOOKING_IDS = [
  "bk_orphan_student",
  "bk_orphan_instructor",
  "bk_overlap_a",
  "bk_overlap_b",
  "bk_overlap_cancelled",
  "bk_adjacent_1",
  "bk_adjacent_2",
  "bk_student_base",
  "bk_student_overlap",
  "bk_date_timestamp",
  "bk_date_iso",
  "bk_date_it_string",
  "bk_date_epoch",
  "bk_date_garbage",
  "bk_dst_gap",
  "bk_dst_ambiguous",
  "bk_status_variants_1",
  "bk_status_variants_2",
  "bk_status_variants_3",
  "bk_status_variants_4",
  "bk_status_unknown",
  "bk_no_duration",
  "bk_bad_duration",
  "bk_price_string",
  "bk_denorm_drift",
  "bk_dup_student_ref",
  "bk_history_nested",
  "bk_deleted",
  "bk_unknown_fields",
];
const FIXTURE_STUDENT_IDS = [
  "st_dup_rossi_a",
  "st_dup_rossi_b",
  "st_bad_phone",
  "st_phone_formats_1",
  "st_phone_formats_2",
  "st_phone_formats_3",
];

describe("§3.2 fixtures", () => {
  it.each(FIXTURE_BOOKING_IDS)("include booking %s", (id) => {
    expect(dataset.bookings.some((doc) => doc.id === id)).toBe(true);
  });

  it.each(FIXTURE_STUDENT_IDS)("include student %s", (id) => {
    expect(dataset.students.some((doc) => doc.id === id)).toBe(true);
  });

  it("give the four date formats one instant, 2026-10-21 14:30 Rome", () => {
    const expected = Date.parse("2026-10-21T12:30:00Z");
    const fromItalian = DateTime.fromFormat(
      text(booking("bk_date_it_string"), "startAt"),
      "dd/MM/yyyy HH:mm",
      {
        zone: ROME,
      },
    );

    expect(instant(booking("bk_date_timestamp"), "startAt").toMillis()).toBe(expected);
    expect(Date.parse(text(booking("bk_date_iso"), "startAt"))).toBe(expected);
    expect(fromItalian.toMillis()).toBe(expected);
    expect(booking("bk_date_epoch").fields.startAt).toBe(expected);
  });

  it("put the four same-instant fixtures on four different instructors and students", () => {
    const ids = ["bk_date_timestamp", "bk_date_iso", "bk_date_it_string", "bk_date_epoch"];
    const docs = ids.map(booking);
    expect(new Set(docs.map((doc) => text(doc, "instructorId"))).size).toBe(4);
    expect(new Set(docs.map((doc) => text(doc, "studentId"))).size).toBe(4);
  });

  it("make bk_overlap_a and bk_overlap_b clash on the instructor only, by 30 minutes", () => {
    const [a, b] = [booking("bk_overlap_a"), booking("bk_overlap_b")];
    expect(compareCodeUnits(a.id, b.id)).toBeLessThan(0);
    expect(text(a, "instructorId")).toBe(text(b, "instructorId"));
    expect(text(a, "studentId")).not.toBe(text(b, "studentId"));
    expect(lessonRange(a)[1] - lessonRange(b)[0]).toBe(30 * 60_000);
  });

  it("make the student overlap clash on the student only, with the winner sorting first", () => {
    const [base, overlap] = [booking("bk_student_base"), booking("bk_student_overlap")];
    expect(compareCodeUnits(base.id, overlap.id)).toBeLessThan(0);
    expect(text(base, "studentId")).toBe(text(overlap, "studentId"));
    expect(text(base, "instructorId")).not.toBe(text(overlap, "instructorId"));
    expect(overlaps(lessonRange(base), lessonRange(overlap))).toBe(true);
  });

  it("make the adjacent pair touch without overlapping", () => {
    const [first, second] = [booking("bk_adjacent_1"), booking("bk_adjacent_2")];
    expect(lessonRange(first)[1]).toBe(lessonRange(second)[0]);
  });

  it.each([
    ["bk_overlap_cancelled", "bk_overlap_a"],
    ["bk_deleted", "bk_price_string"],
  ])("make %s overlap %s on the same instructor", (id, otherId) => {
    const [doc, other] = [booking(id), booking(otherId)];
    expect(text(doc, "instructorId")).toBe(text(other, "instructorId"));
    expect(overlaps(lessonRange(doc), lessonRange(other))).toBe(true);
  });

  it("have no other clashes between fixtures that would block each other", () => {
    // Only booked/confirmed lessons block. Fixtures rejected before the database are skipped.
    const rejectedEarly = [
      "bk_orphan_student",
      "bk_orphan_instructor",
      "bk_bad_duration",
      "bk_status_unknown",
    ];
    const blocking = dataset.bookings.filter(
      (doc) =>
        !/^bk_\d{5}$/.test(doc.id) &&
        !rejectedEarly.includes(doc.id) &&
        doc.fields.deleted !== true &&
        doc.fields.startAt !== undefined &&
        typeof doc.fields.startAt === "object" &&
        ["booked", "confirmed"].includes(text(doc, "status").trim().toLowerCase()),
    );
    const clashes: string[] = [];
    for (const [i, a] of blocking.entries()) {
      for (const b of blocking.slice(i + 1)) {
        const sameKey = ["instructorId", "studentId"].some(
          (field) => text(a, field) === text(b, field),
        );
        if (sameKey && overlaps(lessonRange(a), lessonRange(b))) clashes.push(`${a.id}+${b.id}`);
      }
    }
    expect(clashes).toEqual(["bk_overlap_a+bk_overlap_b", "bk_student_base+bk_student_overlap"]);
  });

  it("make the Rossi sign-ups differ only in email case and spaces", () => {
    const [a, b] = [student("st_dup_rossi_a"), student("st_dup_rossi_b")];
    expect(text(a, "email")).toBe(" Mario.Rossi@Example.com");
    expect(text(b, "email")).toBe("mario.rossi@example.com");
    expect(normalisedEmail(a)).toBe(normalisedEmail(b));
    expect(instant(a, "createdAt") < instant(b, "createdAt")).toBe(true);
    expect(a.fields.phone).toBeUndefined();
    expect(b.fields.phone).toBe("+393471112233");
  });

  it("point bk_dup_student_ref at the newer Rossi doc", () => {
    expect(text(booking("bk_dup_student_ref"), "studentId")).toBe("st_dup_rossi_b");
  });

  it.each([
    ["st_bad_phone", "chiamami dopo le 18"],
    ["st_phone_formats_1", "333 123 4567"],
    ["st_phone_formats_2", "0039 333-123-4567"],
    ["st_phone_formats_3", "+393331234567"],
  ])("give %s the phone %j", (id, phone) => {
    expect(text(student(id), "phone")).toBe(phone);
  });

  it.each<[string, string, unknown]>([
    ["bk_status_variants_1", "status", "Cancelled"],
    ["bk_status_variants_2", "status", "canceled"],
    ["bk_status_variants_3", "status", " CONFIRMED "],
    ["bk_status_variants_4", "status", "noshow"],
    ["bk_status_unknown", "status", "rescheduled"],
    ["bk_bad_duration", "durationMin", 600],
    ["bk_price_string", "price", "45,50"],
    ["bk_denorm_drift", "studentName", "Mario R."],
    ["bk_date_garbage", "startAt", "domani pomeriggio"],
    ["bk_dst_gap", "startAt", "29/03/2026 02:30"],
    ["bk_dst_ambiguous", "startAt", "25/10/2026 02:30"],
    ["bk_orphan_student", "studentId", "st_does_not_exist"],
    ["bk_deleted", "deleted", true],
    ["bk_unknown_fields", "legacyFlag", true],
    ["bk_unknown_fields", "tmp2", "x"],
  ])("give %s.%s the value %j", (id, field, value) => {
    expect(booking(id).fields[field]).toEqual(value);
  });

  it("leave durationMin out of bk_no_duration entirely", () => {
    expect("durationMin" in booking("bk_no_duration").fields).toBe(false);
  });

  it("give bk_orphan_instructor an instructor that doesn't exist", () => {
    const instructorId = text(booking("bk_orphan_instructor"), "instructorId");
    expect(dataset.instructors.some((doc: SeedDoc) => doc.id === instructorId)).toBe(false);
  });

  it("give bk_history_nested three status changes", () => {
    const history = booking("bk_history_nested").fields.history;
    expect(Array.isArray(history) ? history.length : 0).toBe(3);
  });
});
