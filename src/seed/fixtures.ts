import { romeTime, seedTimestamp } from "./calendar.js";
import { cityById } from "./reference-data.js";
import { type SeedDoc, type SeedFields, SeedTimestamp, type SeedValue } from "./types.js";

// Known-bad fixtures from MASTER_PLAN.md §3.2; tests assert on these exact ids. They use a
// dedicated pool of instructors and students that generated bookings never touch, so each
// fixture ends in exactly one predictable outcome. Clashes below are all intentional.

const CITY = cityById("ct_milano");
const PICKUP_POINT_ID = "pp_milano_duomo";
const BOOKED_AT = new SeedTimestamp("2026-09-01T08:00:00.000Z");
const STUDENT_CREATED_AT = new SeedTimestamp("2026-06-01T09:00:00.000Z");

type FixtureStudent = { id: string; firstName: string; lastName: string; phone?: string };

const INSTRUCTORS = [
  { id: "in_fx_01", fullName: "Marco Esposito" },
  { id: "in_fx_02", fullName: "Sara Ricci" },
  { id: "in_fx_03", fullName: "Davide Marino" },
  { id: "in_fx_04", fullName: "Elena Galli" },
];

const POOL_STUDENTS: FixtureStudent[] = [
  { id: "st_fx_01", firstName: "Alessandro", lastName: "Greco" },
  { id: "st_fx_02", firstName: "Chiara", lastName: "Romano" },
  { id: "st_fx_03", firstName: "Luca", lastName: "Colombo" },
  { id: "st_fx_04", firstName: "Francesca", lastName: "Bruno" },
  { id: "st_fx_05", firstName: "Matteo", lastName: "Gallo" },
  { id: "st_fx_06", firstName: "Valentina", lastName: "Conti" },
  { id: "st_fx_07", firstName: "Simone", lastName: "De Luca" },
  { id: "st_fx_08", firstName: "Martina", lastName: "Mancini" },
  { id: "st_fx_09", firstName: "Mario", lastName: "Russo" },
  { id: "st_fx_10", firstName: "Giorgia", lastName: "Costa" },
];

const PHONE_STUDENTS: FixtureStudent[] = [
  { id: "st_bad_phone", firstName: "Paolo", lastName: "Ferri", phone: "chiamami dopo le 18" },
  { id: "st_phone_formats_1", firstName: "Anna", lastName: "Lombardi", phone: "333 123 4567" },
  {
    id: "st_phone_formats_2",
    firstName: "Giulio",
    lastName: "Moretti",
    phone: "0039 333-123-4567",
  },
  { id: "st_phone_formats_3", firstName: "Laura", lastName: "Barbieri", phone: "+393331234567" },
];

export const FIXTURE_INSTRUCTORS: readonly SeedDoc[] = INSTRUCTORS.map(
  ({ id, fullName }, index) => ({
    id,
    fields: {
      fullName,
      email: `${emailName(fullName)}@autoscuola.example`,
      phone: `+3934000000${String(index + 1).padStart(2, "0")}`,
      cityId: CITY.id,
      licenseCategories: ["B"],
      active: true,
    },
  }),
);

export const FIXTURE_STUDENTS: readonly SeedDoc[] = [
  // The same person signed up twice. The older doc lacks phone and tax code; the newer one
  // fills those gaps when they are merged.
  {
    id: "st_dup_rossi_a",
    fields: {
      firstName: "Mario",
      lastName: "Rossi",
      email: " Mario.Rossi@Example.com",
      cityId: CITY.id,
      licenseCategory: "B",
      createdAt: new SeedTimestamp("2026-03-01T10:00:00.000Z"),
    },
  },
  {
    id: "st_dup_rossi_b",
    fields: {
      firstName: "Mario",
      lastName: "Rossi",
      email: "mario.rossi@example.com",
      phone: "+393471112233",
      taxCode: "RSSMRA85M01F205Z",
      cityId: CITY.id,
      licenseCategory: "B",
      createdAt: new SeedTimestamp("2026-05-10T10:00:00.000Z"),
    },
  },
  ...[...POOL_STUDENTS, ...PHONE_STUDENTS].map((student, index) => ({
    id: student.id,
    fields: {
      firstName: student.firstName,
      lastName: student.lastName,
      email: `${emailName(`${student.firstName} ${student.lastName}`)}.fx@example.com`,
      phone: student.phone ?? `+3933300000${String(index + 1).padStart(2, "0")}`,
      cityId: CITY.id,
      licenseCategory: "B",
      createdAt: STUDENT_CREATED_AT,
    },
  })),
];

export const FIXTURE_BOOKINGS: readonly SeedDoc[] = [
  booking("bk_orphan_student", "in_fx_01", "st_does_not_exist", at("2026-09-14", "09:00")),
  booking("bk_orphan_instructor", "in_does_not_exist", "st_fx_01", at("2026-09-14", "09:00")),

  // One instructor: a is stored first and wins, b overlaps it by 30 minutes, and the
  // cancelled one overlaps too but doesn't block.
  booking("bk_overlap_a", "in_fx_01", "st_fx_02", at("2026-09-15", "10:00")),
  booking("bk_overlap_b", "in_fx_01", "st_fx_03", at("2026-09-15", "10:30")),
  booking("bk_overlap_cancelled", "in_fx_01", "st_fx_04", at("2026-09-15", "10:15"), {
    status: "cancelled",
  }),

  // Touching, not overlapping: [10:00, 11:00) and [11:00, 12:00).
  booking("bk_adjacent_1", "in_fx_02", "st_fx_02", at("2026-09-16", "10:00")),
  booking("bk_adjacent_2", "in_fx_02", "st_fx_03", at("2026-09-16", "11:00")),

  // One student with two instructors at once: bk_student_base sorts first and wins.
  booking("bk_student_base", "in_fx_01", "st_fx_05", at("2026-09-17", "10:00")),
  booking("bk_student_overlap", "in_fx_02", "st_fx_05", at("2026-09-17", "10:30")),

  // Four formats of one instant, 2026-10-21 14:30 Rome (12:30Z), on four different pairs.
  booking("bk_date_timestamp", "in_fx_01", "st_fx_01", at("2026-10-21", "14:30")),
  booking("bk_date_iso", "in_fx_02", "st_fx_02", "2026-10-21T14:30:00+02:00"),
  booking("bk_date_it_string", "in_fx_03", "st_fx_03", "21/10/2026 14:30"),
  booking("bk_date_epoch", "in_fx_04", "st_fx_04", 1_792_585_800_000),

  booking("bk_date_garbage", "in_fx_03", "st_fx_06", "domani pomeriggio"),
  // 02:30 doesn't exist on 29/03/2026 in Rome, and happens twice on 25/10/2026.
  booking("bk_dst_gap", "in_fx_03", "st_fx_06", "29/03/2026 02:30"),
  booking("bk_dst_ambiguous", "in_fx_03", "st_fx_06", "25/10/2026 02:30"),

  booking("bk_status_variants_1", "in_fx_03", "st_fx_06", at("2026-09-18", "09:00"), {
    status: "Cancelled",
  }),
  booking("bk_status_variants_2", "in_fx_03", "st_fx_06", at("2026-09-18", "10:00"), {
    status: "canceled",
  }),
  booking("bk_status_variants_3", "in_fx_03", "st_fx_06", at("2026-09-18", "11:00"), {
    status: " CONFIRMED ",
  }),
  booking("bk_status_variants_4", "in_fx_03", "st_fx_06", at("2026-09-18", "12:00"), {
    status: "noshow",
  }),
  booking("bk_status_unknown", "in_fx_03", "st_fx_06", at("2026-09-18", "13:00"), {
    status: "rescheduled",
  }),

  booking("bk_no_duration", "in_fx_04", "st_fx_07", at("2026-09-19", "09:00"), {
    omit: ["durationMin"],
  }),
  booking("bk_bad_duration", "in_fx_04", "st_fx_07", at("2026-09-19", "10:00"), {
    overrides: { durationMin: 600 },
  }),
  booking("bk_price_string", "in_fx_04", "st_fx_07", at("2026-09-19", "11:00"), {
    overrides: { price: "45,50" },
  }),
  // Overlaps bk_price_string on the same instructor, but a deleted booking never blocks.
  booking("bk_deleted", "in_fx_04", "st_fx_08", at("2026-09-19", "11:30"), {
    overrides: { deleted: true },
  }),

  booking("bk_denorm_drift", "in_fx_04", "st_fx_09", at("2026-09-21", "09:00"), {
    overrides: { studentName: "Mario R." },
  }),
  booking("bk_dup_student_ref", "in_fx_04", "st_dup_rossi_b", at("2026-09-21", "10:00")),
  booking("bk_history_nested", "in_fx_04", "st_fx_10", at("2026-09-21", "11:00"), {
    status: "completed",
    overrides: {
      history: [
        { status: "booked", at: BOOKED_AT, by: "app" },
        {
          status: "confirmed",
          at: new SeedTimestamp("2026-09-02T10:00:00.000Z"),
          by: "segreteria",
        },
        {
          status: "completed",
          at: new SeedTimestamp("2026-09-21T10:00:00.000Z"),
          by: "istruttore",
        },
      ],
    },
  }),
  booking("bk_unknown_fields", "in_fx_04", "st_fx_10", at("2026-09-21", "12:00"), {
    overrides: { legacyFlag: true, tmp2: "x" },
  }),
];

type BookingOptions = {
  status?: string;
  overrides?: SeedFields;
  omit?: readonly string[];
};

function booking(
  id: string,
  instructorId: string,
  studentId: string,
  startAt: SeedValue,
  { status = "confirmed", overrides = {}, omit = [] }: BookingOptions = {},
): SeedDoc {
  const fields: SeedFields = {
    studentId,
    instructorId,
    pickupPointId: PICKUP_POINT_ID,
    startAt,
    durationMin: 60,
    status,
    price: 45,
    paid: false,
    studentName: studentName(studentId),
    instructorName: instructorName(instructorId),
    cityName: CITY.name,
    history: [{ status: "booked", at: BOOKED_AT, by: "app" }],
    createdAt: BOOKED_AT,
    ...overrides,
  };
  return {
    id,
    fields: Object.fromEntries(Object.entries(fields).filter(([field]) => !omit.includes(field))),
  };
}

function at(date: string, time: string): SeedTimestamp {
  return seedTimestamp(romeTime(date, time));
}

function studentName(studentId: string): string {
  if (studentId.startsWith("st_dup_rossi")) return "Mario Rossi";
  const student = POOL_STUDENTS.find((candidate) => candidate.id === studentId);
  return student ? `${student.firstName} ${student.lastName}` : "Studente Sconosciuto";
}

function instructorName(instructorId: string): string {
  return (
    INSTRUCTORS.find((candidate) => candidate.id === instructorId)?.fullName ??
    "Istruttore Sconosciuto"
  );
}

function emailName(fullName: string): string {
  return fullName
    .toLowerCase()
    .replaceAll(" ", ".")
    .replace(/[^a-z.]/g, "");
}
