import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { ROME, SNAPSHOT, WINDOW_DAYS, WINDOW_START } from "../../src/seed/calendar.js";
import { buildSeedDataset, EXPORT_UPDATE_TIME } from "../../src/seed/dataset.js";
import { toExportJson } from "../../src/seed/json-export.js";
import { cityById, PICKUP_POINTS } from "../../src/seed/reference-data.js";
import { type SeedDoc, SeedTimestamp } from "../../src/seed/types.js";
import { COLLECTIONS } from "../../src/source/collections.js";
import { compareCodeUnits } from "../../src/util/order.js";
import { docById, instant, lessonRange, normalisedEmail, text } from "../support/seed-fields.js";

const dataset = buildSeedDataset();
const generatedBookings = dataset.bookings.filter((doc) => /^bk_\d{5}$/.test(doc.id));
const generatedStudents = dataset.students.filter((doc) => /^st_\d{4}$/.test(doc.id));
const generatedInstructors = dataset.instructors.filter((doc) => /^in_\d{3}$/.test(doc.id));

describe("buildSeedDataset", () => {
  it("is identical on every run", () => {
    expect(toExportJson(buildSeedDataset(), EXPORT_UPDATE_TIME)).toBe(
      toExportJson(dataset, EXPORT_UPDATE_TIME),
    );
  });

  it("has the planned volumes", () => {
    expect(dataset.cities).toHaveLength(3);
    expect(dataset.pickupPoints).toHaveLength(12);
    expect(generatedInstructors).toHaveLength(15);
    expect(generatedStudents).toHaveLength(300);
    expect(generatedBookings.length).toBeGreaterThan(1800);
    expect(generatedBookings.length).toBeLessThan(2400);
  });

  it.each(COLLECTIONS)("lists %s in Firestore's id order", (collection) => {
    const ids = dataset[collection].map((doc) => doc.id);
    expect(ids).toEqual([...ids].sort(compareCodeUnits));
  });
});

describe("generated students", () => {
  const groups = Map.groupBy(generatedStudents, normalisedEmail);
  const duplicateGroups = [...groups.values()].filter((docs) => docs.length > 1);

  it("include about 3% second sign-ups, merged by email", () => {
    expect(duplicateGroups).toHaveLength(9);
    expect(duplicateGroups.every((docs) => docs.length === 2)).toBe(true);
  });

  it("leave a gap in the older sign-up for the newer one to fill", () => {
    for (const docs of duplicateGroups) {
      const [older, newer] = [...docs].sort(
        (a, b) => instant(a, "createdAt").toMillis() - instant(b, "createdAt").toMillis(),
      );
      expect(older?.fields.phone).toBeUndefined();
      expect(newer?.fields.phone).toMatch(/^\+393\d{9}$/);
    }
  });
});

describe("generated bookings", () => {
  const students = new Map(dataset.students.map((doc) => [doc.id, doc]));
  const personOf = (booking: SeedDoc) => {
    const student = students.get(text(booking, "studentId"));
    if (!student) throw new Error(`${booking.id} has no student`);
    return normalisedEmail(student);
  };

  it.each([
    ["instructor", (booking: SeedDoc) => text(booking, "instructorId")],
    ["person, counting duplicate sign-ups as one", personOf],
  ])("never overlap for the same %s", (_case, keyOf) => {
    for (const bookings of Map.groupBy(generatedBookings, keyOf).values()) {
      const ranges = bookings.map(lessonRange).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i - 1]?.[1]).toBeLessThanOrEqual(ranges[i]?.[0] ?? 0);
      }
    }
  });

  it("reference a student, instructor and pickup point in the same city", () => {
    for (const booking of generatedBookings) {
      const instructor = docById(dataset.instructors, text(booking, "instructorId"));
      const student = docById(dataset.students, text(booking, "studentId"));
      const pickup = PICKUP_POINTS.find((point) => point.id === text(booking, "pickupPointId"));
      const cityId = text(instructor, "cityId");
      expect(text(student, "cityId")).toBe(cityId);
      expect(pickup?.cityId).toBe(cityId);
    }
  });

  it("copy names exactly, so only the drift fixture warns", () => {
    for (const booking of generatedBookings) {
      const instructor = docById(dataset.instructors, text(booking, "instructorId"));
      const student = docById(dataset.students, text(booking, "studentId"));
      expect(text(booking, "studentName")).toBe(
        `${text(student, "firstName")} ${text(student, "lastName")}`,
      );
      expect(text(booking, "instructorName")).toBe(text(instructor, "fullName"));
      expect(text(booking, "cityName")).toBe(cityById(text(instructor, "cityId")).name);
    }
  });

  it("fall Monday to Saturday, 08:00 to 20:00 Rome time, inside the 8-week window", () => {
    const windowEnd = WINDOW_START.plus({ days: WINDOW_DAYS });
    for (const booking of generatedBookings) {
      const [startMs, endMs] = lessonRange(booking);
      const start = DateTime.fromMillis(startMs, { zone: ROME });
      const end = DateTime.fromMillis(endMs, { zone: ROME });
      expect(start >= WINDOW_START && start < windowEnd).toBe(true);
      expect(start.weekday).not.toBe(7);
      expect(start.hour).toBeGreaterThanOrEqual(8);
      expect(end.hasSame(start, "day")).toBe(true);
      expect(end.hour * 60 + end.minute).toBeLessThanOrEqual(20 * 60);
    }
  });

  it("use past statuses before the snapshot and future ones after it", () => {
    for (const booking of generatedBookings) {
      const status = text(booking, "status");
      const isPast = lessonRange(booking)[1] <= SNAPSHOT.toMillis();
      const allowed = isPast
        ? ["completed", "no_show", "cancelled"]
        : ["booked", "confirmed", "cancelled"];
      expect(allowed).toContain(status);
    }
  });

  it("have a history in time order, ending with the current status, none after the snapshot", () => {
    for (const booking of generatedBookings) {
      const history = booking.fields.history;
      if (!Array.isArray(history)) throw new Error(`${booking.id} has no history`);
      const events = history.map((entry) => {
        if (typeof entry !== "object" || entry === null || !("at" in entry)) {
          throw new Error(`${booking.id} has a malformed history entry`);
        }
        const at = entry.at;
        if (!(at instanceof SeedTimestamp)) throw new Error(`${booking.id} history.at`);
        return { status: entry.status, ms: Date.parse(at.iso) };
      });
      expect(events.at(-1)?.status).toBe(text(booking, "status"));
      for (let i = 1; i < events.length; i++) {
        expect(events[i]?.ms).toBeGreaterThan(events[i - 1]?.ms ?? 0);
      }
      expect(Math.max(...events.map((event) => event.ms))).toBeLessThanOrEqual(SNAPSHOT.toMillis());
    }
  });

  it("never use the fixture pool of instructors and students", () => {
    for (const booking of generatedBookings) {
      expect(text(booking, "instructorId")).toMatch(/^in_\d{3}$/);
      expect(text(booking, "studentId")).toMatch(/^st_\d{4}$/);
    }
  });
});
