import { base, Faker, it as italian } from "@faker-js/faker";
import type { DateTime } from "luxon";
import { SNAPSHOT, seedTimestamp, WINDOW_DAYS, WINDOW_START } from "./calendar.js";
import { CITIES, type City, cityById, pickupPointsIn } from "./reference-data.js";
import type { SeedDoc, SeedFields, SeedValue } from "./types.js";

export const FAKER_SEED = 42;

const INSTRUCTORS_PER_CITY = 5;
const STUDENT_DOCS = 300;
/** About 3% of the student docs are a second sign-up by someone already in the list. */
const DUPLICATE_STUDENT_DOCS = 9;
const EXTRA_LICENSE_CATEGORIES = ["AM", "A1", "A2", "A"] as const;
const DURATIONS_MIN = [30, 45, 60, 60, 60, 60, 90, 120];
const PRICE_EUR_BY_DURATION = new Map([
  [30, 25],
  [45, 35],
  [60, 45],
  [90, 65],
  [120, 85],
]);
const FIRST_LESSON_HOUR = 8;
const LAST_LESSON_END_HOUR = 20;
const NOTES = [
  "Prima guida in autostrada",
  "Ripasso parcheggio in parallelo",
  "Esame tra due settimane",
  "Guida notturna",
  "Rotatorie e precedenze",
];

type Instructor = { id: string; fullName: string; cityId: string };
/** One real person. A duplicated student has two docs, but only one diary. */
type Person = {
  firstName: string;
  lastName: string;
  cityId: string;
  docIds: string[];
  busy: Array<[startMs: number, endMs: number]>;
};
type MutableDoc = { id: string; fields: Record<string, SeedValue> };

export type GeneratedData = {
  instructors: SeedDoc[];
  students: SeedDoc[];
  bookings: SeedDoc[];
};

export function generateNormalData(): GeneratedData {
  // A private seeded instance: the output depends only on FAKER_SEED and the call order below.
  const faker = new Faker({ locale: [italian, base] });
  faker.seed(FAKER_SEED);

  const instructors = generateInstructors(faker);
  const { students, people } = generateStudents(faker);
  const bookings = generateBookings(faker, instructors.people, people);
  return { instructors: instructors.docs, students, bookings };
}

function generateInstructors(faker: Faker): { docs: SeedDoc[]; people: Instructor[] } {
  const docs: SeedDoc[] = [];
  const people: Instructor[] = [];
  for (const city of CITIES) {
    for (let i = 0; i < INSTRUCTORS_PER_CITY; i++) {
      const id = `in_${String(people.length + 1).padStart(3, "0")}`;
      const firstName = faker.person.firstName();
      const lastName = faker.person.lastName();
      const fullName = `${firstName} ${lastName}`;
      const extras = faker.helpers.arrayElements(EXTRA_LICENSE_CATEGORIES, { min: 0, max: 2 });
      people.push({ id, fullName, cityId: city.id });
      docs.push({
        id,
        fields: {
          fullName,
          email: `${ascii(firstName)}.${ascii(lastName)}@autoscuola.example`,
          phone: mobilePhone(faker),
          cityId: city.id,
          licenseCategories: [...EXTRA_LICENSE_CATEGORIES.filter((c) => extras.includes(c)), "B"],
          active: true,
        },
      });
    }
  }
  return { docs, people };
}

function generateStudents(faker: Faker): { students: SeedDoc[]; people: Person[] } {
  const uniquePeople = STUDENT_DOCS - DUPLICATE_STUDENT_DOCS;
  const docs: MutableDoc[] = [];
  const people: Person[] = [];
  const createdAts: DateTime[] = [];

  for (let n = 1; n <= uniquePeople; n++) {
    const id = studentId(n);
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const city = faker.helpers.arrayElement(CITIES);
    const createdAt = randomInstant(faker, WINDOW_START.minus({ months: 8 }), WINDOW_START);
    const hasTaxCode = faker.datatype.boolean({ probability: 0.7 });
    docs.push({
      id,
      fields: {
        firstName,
        lastName,
        // The number keeps emails unique, so only the intended duplicates merge.
        email: `${ascii(firstName)}.${ascii(lastName)}.${n}@example.com`,
        phone: mobilePhone(faker),
        ...(hasTaxCode ? { taxCode: taxCode(faker) } : {}),
        cityId: city.id,
        licenseCategory: faker.helpers.weightedArrayElement([
          { weight: 85, value: "B" },
          { weight: 8, value: "AM" },
          { weight: 4, value: "A2" },
          { weight: 3, value: "A" },
        ]),
        createdAt: seedTimestamp(createdAt),
      },
    });
    people.push({ firstName, lastName, cityId: city.id, docIds: [id], busy: [] });
    createdAts.push(createdAt);
  }

  const originals = faker.helpers
    .arrayElements([...people.keys()], DUPLICATE_STUDENT_DOCS)
    .sort((a, b) => a - b);
  originals.forEach((index, k) => {
    const original = at(docs, index);
    const id = studentId(uniquePeople + k + 1);
    // The person signed up again later with a messier email. The older doc is missing the
    // phone, so merging has a gap to fill from the newer one.
    const { phone: _phone, ...withoutPhone } = original.fields;
    docs.push({
      id,
      fields: {
        ...original.fields,
        email: messyEmail(faker, String(original.fields.email)),
        createdAt: seedTimestamp(randomInstant(faker, at(createdAts, index), SNAPSHOT)),
      },
    });
    original.fields = withoutPhone;
    at(people, index).docIds.push(id);
  });

  return { students: docs, people };
}

function generateBookings(faker: Faker, instructors: Instructor[], people: Person[]): SeedDoc[] {
  const bookings: SeedDoc[] = [];
  for (let day = 0; day < WINDOW_DAYS; day++) {
    const date = WINDOW_START.plus({ days: day });
    if (date.weekday === 7) continue; // no lessons on Sundays

    for (const instructor of instructors) {
      const city = cityById(instructor.cityId);
      const candidates = people.filter((person) => person.cityId === city.id);
      const dayEnd = date.set({ hour: LAST_LESSON_END_HOUR });
      let cursor = date.set({ hour: FIRST_LESSON_HOUR }).plus({
        minutes: faker.helpers.arrayElement([0, 30, 60, 90]),
      });

      // Lessons follow each other through the day, so an instructor never overlaps.
      const lessons = faker.number.int({ min: 1, max: 5 });
      for (let k = 0; k < lessons; k++) {
        const durationMin = faker.helpers.arrayElement(DURATIONS_MIN);
        const start = cursor;
        const end = start.plus({ minutes: durationMin });
        if (end > dayEnd) break;

        const person = bookFreePerson(faker, candidates, start, end);
        if (person) {
          const id = `bk_${String(bookings.length + 1).padStart(5, "0")}`;
          bookings.push(
            buildBooking(faker, { id, instructor, city, person, start, end, durationMin }),
          );
        }
        cursor = end.plus({ minutes: faker.helpers.arrayElement([0, 0, 15, 30, 60]) });
      }
    }
  }
  return bookings;
}

/** Picks someone free for the whole lesson, so a student never overlaps either. */
function bookFreePerson(
  faker: Faker,
  candidates: Person[],
  start: DateTime,
  end: DateTime,
): Person | undefined {
  const [startMs, endMs] = [start.toMillis(), end.toMillis()];
  for (let attempt = 0; attempt < 20; attempt++) {
    const person = faker.helpers.arrayElement(candidates);
    if (person.busy.every(([busyStart, busyEnd]) => endMs <= busyStart || startMs >= busyEnd)) {
      person.busy.push([startMs, endMs]);
      return person;
    }
  }
  return undefined;
}

type Lesson = {
  id: string;
  instructor: Instructor;
  city: City;
  person: Person;
  start: DateTime;
  end: DateTime;
  durationMin: number;
};

function buildBooking(faker: Faker, lesson: Lesson): SeedDoc {
  const { id, instructor, city, person, start, end, durationMin } = lesson;
  const studentId = faker.helpers.arrayElement(person.docIds);
  const pickupPoint = faker.helpers.arrayElement(pickupPointsIn(city.id));
  const status = pickStatus(faker, end);
  const createdAt = pickCreatedAt(faker, start);
  const history = buildHistory(faker, { status, createdAt, start, end });
  const price = PRICE_EUR_BY_DURATION.get(durationMin);
  if (price === undefined) throw new Error(`No price for a ${durationMin}-minute lesson`);
  const paid = isPaid(faker, status);
  const notes = faker.datatype.boolean({ probability: 0.1 })
    ? faker.helpers.arrayElement(NOTES)
    : undefined;

  const fields: SeedFields = {
    studentId,
    instructorId: instructor.id,
    pickupPointId: pickupPoint.id,
    startAt: seedTimestamp(start),
    durationMin,
    status,
    price,
    paid,
    // Copied names match the source docs exactly; only the drift fixture differs.
    studentName: `${person.firstName} ${person.lastName}`,
    instructorName: instructor.fullName,
    cityName: city.name,
    history,
    ...(notes === undefined ? {} : { notes }),
    createdAt: seedTimestamp(createdAt),
  };
  return { id, fields };
}

function pickStatus(faker: Faker, end: DateTime): string {
  if (end <= SNAPSHOT) {
    return faker.helpers.weightedArrayElement([
      { weight: 85, value: "completed" },
      { weight: 5, value: "no_show" },
      { weight: 10, value: "cancelled" },
    ]);
  }
  return faker.helpers.weightedArrayElement([
    { weight: 40, value: "booked" },
    { weight: 50, value: "confirmed" },
    { weight: 10, value: "cancelled" },
  ]);
}

/** Booked 1–21 days ahead, but never after the snapshot. */
function pickCreatedAt(faker: Faker, start: DateTime): DateTime {
  const createdAt = start.minus({
    days: faker.number.int({ min: 1, max: 21 }),
    hours: faker.number.int({ min: 0, max: 10 }),
  });
  return createdAt < SNAPSHOT
    ? createdAt
    : SNAPSHOT.minus({ hours: faker.number.int({ min: 1, max: 72 }) });
}

type HistoryInput = { status: string; createdAt: DateTime; start: DateTime; end: DateTime };

/** Status changes in time order, ending with the current status, none after the snapshot. */
function buildHistory(faker: Faker, { status, createdAt, start, end }: HistoryInput): SeedValue[] {
  const history: SeedValue[] = [event("booked", createdAt, "app")];
  if (status === "booked") return history;

  if (status === "cancelled") {
    const cancelledAt = randomInstant(faker, createdAt, earliest(start, SNAPSHOT));
    history.push(
      event("cancelled", cancelledAt, faker.helpers.arrayElement(["app", "segreteria"])),
    );
    return history;
  }

  const confirmedAt = earliest(
    createdAt.plus({ hours: faker.number.int({ min: 1, max: 48 }) }),
    start.minus({ hours: 1 }),
    SNAPSHOT,
  );
  history.push(event("confirmed", confirmedAt, "segreteria"));
  if (status === "completed" || status === "no_show") {
    history.push(event(status, end, "istruttore"));
  }
  return history;
}

function isPaid(faker: Faker, status: string): boolean {
  if (status === "cancelled") return false;
  const probability = status === "completed" ? 0.9 : status === "no_show" ? 0.5 : 0.3;
  return faker.datatype.boolean({ probability });
}

function event(status: string, when: DateTime, by: string): SeedFields {
  return { status, at: seedTimestamp(when), by };
}

/** A whole minute strictly after `from` and no later than `to`. */
function randomInstant(faker: Faker, from: DateTime, to: DateTime): DateTime {
  const minutes = Math.floor(to.diff(from, "minutes").minutes);
  return from.plus({ minutes: faker.number.int({ min: 1, max: Math.max(1, minutes) }) });
}

function earliest(first: DateTime, ...rest: DateTime[]): DateTime {
  return rest.reduce((min, value) => (value < min ? value : min), first);
}

/** A valid Italian mobile (32x, 33x, 34x, 38x), so only the phone fixtures fail to parse. */
function mobilePhone(faker: Faker): string {
  return `+393${faker.helpers.arrayElement(["2", "3", "4", "8"])}${faker.string.numeric(8)}`;
}

/** Shaped like a codice fiscale (16 characters), without a valid check letter. */
function taxCode(faker: Faker): string {
  const letters = (length: number) => faker.string.alpha({ length, casing: "upper" });
  const digits = (length: number) => faker.string.numeric(length);
  return `${letters(6)}${digits(2)}${letters(1)}${digits(2)}${letters(1)}${digits(3)}${letters(1)}`;
}

function messyEmail(faker: Faker, email: string): string {
  const capitalised = email.replace(
    /(^|[.@])([a-z])/g,
    (_match, sep: string, c: string) => sep + c.toUpperCase(),
  );
  return faker.helpers.arrayElement([capitalised, ` ${email}`, `${email} `, email.toUpperCase()]);
}

function ascii(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function studentId(n: number): string {
  return `st_${String(n).padStart(4, "0")}`;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`No item at index ${index}`);
  return item;
}
