import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPgError } from "../../src/db/errors.js";
import { MIGRATIONS_DIR, runMigrations } from "../../src/db/migrate.js";
import { createLogger } from "../../src/logger.js";
import { createTestDatabase, type TestDatabase } from "../support/test-database.js";

const silent = createLogger("silent");

describe("migrations", () => {
  it("build the schema from an empty database, and a second run does nothing", async () => {
    const empty = await createTestDatabase({ empty: true });
    try {
      const first = await runMigrations(empty.pool, MIGRATIONS_DIR, silent);
      const second = await runMigrations(empty.pool, MIGRATIONS_DIR, silent);
      const { rows } = await empty.pool.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' order by 1",
      );

      expect(first.applied).toEqual([
        "001_extensions",
        "002_core_tables",
        "003_bookings",
        "004_migration_bookkeeping",
      ]);
      expect(second.applied).toEqual([]);
      expect(rows.map((row) => row.table_name)).toEqual([
        "booking_events",
        "bookings",
        "cities",
        "instructors",
        "legacy_id_map",
        "migration_checkpoints",
        "migration_rejects",
        "migration_runs",
        "migration_warnings",
        "pickup_points",
        "schema_migrations",
        "students",
      ]);
    } finally {
      await empty.drop();
    }
  });
});

describe("constraints", () => {
  let t: TestDatabase;
  const ids = { city: "", instructorA: "", instructorB: "", studentA: "", studentB: "" };

  beforeAll(async () => {
    t = await createTestDatabase();
    ids.city = await insertId("insert into cities (legacy_id, name) values ('ct_x', 'Milano')");
    ids.instructorA = await insertInstructor("in_a");
    ids.instructorB = await insertInstructor("in_b");
    ids.studentA = await insertStudent("st_a");
    ids.studentB = await insertStudent("st_b");
    // Every overlap case is checked against this lesson: 10:00–11:00 Rome, confirmed.
    await t.pool.query(bookingSql, bookingParams({}));
  });

  afterAll(async () => {
    await t.drop();
  });

  type BookingInput = {
    legacyId?: string;
    instructor?: "A" | "B";
    student?: "A" | "B";
    start?: string;
    end?: string;
    status?: string;
    deleted?: boolean;
    priceCents?: number;
  };

  const bookingSql = `
    insert into bookings (legacy_id, instructor_id, student_id, starts_at, ends_at, status, deleted_at, price_cents)
    values ($1, $2, $3, $4, $5, $6, $7, $8)`;

  function bookingParams(input: BookingInput): unknown[] {
    return [
      input.legacyId ?? "bk_existing",
      input.instructor === "B" ? ids.instructorB : ids.instructorA,
      input.student === "B" ? ids.studentB : ids.studentA,
      input.start ?? "2026-09-15T08:00:00Z",
      input.end ?? "2026-09-15T09:00:00Z",
      input.status ?? "confirmed",
      input.deleted ? "2026-09-01T00:00:00Z" : null,
      input.priceCents ?? 4500,
    ];
  }

  describe("no overlapping active lessons", () => {
    // Different student and instructor unless the case says otherwise; [08:30, 09:30) UTC.
    const overlapping = { legacyId: "bk_new", instructor: "B", student: "B" } as const;
    const atHalfPast = { start: "2026-09-15T08:30:00Z", end: "2026-09-15T09:30:00Z" };

    it.each<[string, BookingInput, string]>([
      [
        "the same instructor overlaps",
        { ...overlapping, ...atHalfPast, instructor: "A" },
        "bookings_no_instructor_overlap",
      ],
      [
        "the same student overlaps",
        { ...overlapping, ...atHalfPast, student: "A" },
        "bookings_no_student_overlap",
      ],
      [
        "the new lesson is only booked",
        { ...overlapping, ...atHalfPast, instructor: "A", status: "booked" },
        "bookings_no_instructor_overlap",
      ],
    ])("rejects a lesson when %s", async (_case, input, constraint) => {
      expect(await attempt([[bookingSql, bookingParams(input)]])).toEqual({
        code: "23P01",
        constraint,
      });
    });

    it.each<[string, BookingInput]>([
      [
        "it starts as the other ends",
        {
          ...overlapping,
          instructor: "A",
          start: "2026-09-15T09:00:00Z",
          end: "2026-09-15T10:00:00Z",
        },
      ],
      [
        "it ends as the other starts",
        {
          ...overlapping,
          instructor: "A",
          start: "2026-09-15T07:00:00Z",
          end: "2026-09-15T08:00:00Z",
        },
      ],
      ["it is cancelled", { ...overlapping, ...atHalfPast, instructor: "A", status: "cancelled" }],
      ["it is completed", { ...overlapping, ...atHalfPast, instructor: "A", status: "completed" }],
      ["it is a no-show", { ...overlapping, ...atHalfPast, instructor: "A", status: "no_show" }],
      ["it is deleted", { ...overlapping, ...atHalfPast, instructor: "A", deleted: true }],
      ["nobody is shared", { ...overlapping, ...atHalfPast }],
    ])("accepts an overlapping time when %s", async (_case, input) => {
      expect(await attempt([[bookingSql, bookingParams(input)]])).toEqual({ code: "ok" });
    });

    it("stops blocking once the existing lesson is cancelled", async () => {
      const cancelExisting =
        "update bookings set status = 'cancelled' where legacy_id = 'bk_existing'";
      const result = await attempt([
        [cancelExisting, []],
        [bookingSql, bookingParams({ ...overlapping, ...atHalfPast, instructor: "A" })],
      ]);
      expect(result).toEqual({ code: "ok" });
    });
  });

  describe("check constraints", () => {
    const lesson = { legacyId: "bk_new", instructor: "B", student: "B" } as const;

    const at = (start: string, end: string) => ({ ...lesson, start, end });
    const oneHour = at("2026-09-16T10:00:00Z", "2026-09-16T11:00:00Z");

    // Statements are built lazily: the ids only exist once beforeAll has run.
    it.each<[string, () => [string, unknown[]]]>([
      [
        "a lesson ending before it starts",
        () => [bookingSql, bookingParams(at("2026-09-16T10:00:00Z", "2026-09-16T09:00:00Z"))],
      ],
      [
        "a 10-minute lesson",
        () => [bookingSql, bookingParams(at("2026-09-16T10:00:00Z", "2026-09-16T10:10:00Z"))],
      ],
      [
        "a 5-hour lesson",
        () => [bookingSql, bookingParams(at("2026-09-16T10:00:00Z", "2026-09-16T15:00:00Z"))],
      ],
      ["a negative price", () => [bookingSql, bookingParams({ ...oneHour, priceCents: -1 })]],
      [
        "an unknown status",
        () => [bookingSql, bookingParams({ ...oneHour, status: "rescheduled" })],
      ],
      [
        "a phone that isn't E.164",
        () => ["update students set phone_e164 = '333 123 4567' where legacy_id = 'st_a'", []],
      ],
      [
        "a lower-case tax code",
        () => ["update students set tax_code = 'rssmra85m01f205z' where legacy_id = 'st_a'", []],
      ],
      [
        "an unknown licence category",
        () => ["update students set license_category = 'C' where legacy_id = 'st_a'", []],
      ],
      [
        "a latitude above 90",
        () => [
          "insert into pickup_points (legacy_id, city_id, name, lat) values ('pp_x', $1, 'X', 91)",
          [ids.city],
        ],
      ],
    ])("rejects %s", async (_case, statement) => {
      expect((await attempt([statement()])).code).toBe("23514");
    });
  });

  it("rejects a booking for a student that doesn't exist", async () => {
    const params = bookingParams({
      legacyId: "bk_new",
      instructor: "B",
      start: "2026-09-16T10:00:00Z",
      end: "2026-09-16T11:00:00Z",
    });
    params[2] = "00000000-0000-4000-8000-000000000000";
    expect((await attempt([[bookingSql, params]])).code).toBe("23503");
  });

  it.each([
    [
      "a second active student with the same email in another case",
      "Mario.Rossi@example.com",
      null,
      "23505",
    ],
    [
      "a deleted student with the same email",
      "mario.rossi@example.com",
      "2026-01-01T00:00:00Z",
      "ok",
    ],
  ])("handles %s", async (_case, email, deletedAt, expected) => {
    const sql = `insert into students (legacy_id, first_name, last_name, email, deleted_at)
                 values ('st_new', 'Mario', 'Rossi', $1, $2)`;
    expect(
      (
        await attempt([
          ["update students set email = 'mario.rossi@example.com' where legacy_id = 'st_a'", []],
          [sql, [email, deletedAt]],
        ])
      ).code,
    ).toBe(expected);
  });

  it("rejects a second row with the same legacy id", async () => {
    expect((await attempt([[bookingSql, bookingParams({})]])).code).toBe("23505");
  });

  it("moves updated_at on a real update, and not when an upsert skips the row", async () => {
    const created = await t.pool.query<{ updated_at: Date }>(
      "insert into cities (legacy_id, name) values ('ct_trigger', 'Roma') returning updated_at",
    );
    const skipped = await t.pool.query(
      `insert into cities (legacy_id, name) values ('ct_trigger', 'Rome')
       on conflict (legacy_id) do update set name = excluded.name where false returning updated_at`,
    );
    const updated = await t.pool.query<{ updated_at: Date }>(
      "update cities set name = 'Roma Capitale' where legacy_id = 'ct_trigger' returning updated_at",
    );

    expect(skipped.rowCount).toBe(0);
    expect(updated.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      created.rows[0]?.updated_at.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });

  it("ignores a booking event that was already recorded", async () => {
    const sql = `insert into booking_events (booking_id, status, occurred_at)
                 select id, 'booked', '2026-09-01T08:00:00Z' from bookings where legacy_id = 'bk_existing'
                 on conflict do nothing`;
    const first = await t.pool.query(sql);
    const second = await t.pool.query(sql);
    expect([first.rowCount, second.rowCount]).toEqual([1, 0]);
  });

  async function attempt(statements: Array<[string, unknown[]]>) {
    const client = await t.pool.connect();
    try {
      await client.query("begin");
      for (const [sql, params] of statements) await client.query(sql, params);
      return { code: "ok" };
    } catch (error) {
      if (!isPgError(error)) throw error;
      return error.code === "23P01"
        ? { code: error.code, constraint: error.constraint }
        : { code: error.code };
    } finally {
      await client.query("rollback");
      client.release();
    }
  }

  async function insertId(sql: string, params: unknown[] = []): Promise<string> {
    const { rows } = await t.pool.query<{ id: string }>(`${sql} returning id`, params);
    const id = rows[0]?.id;
    if (!id) throw new Error(`No id from: ${sql}`);
    return id;
  }

  function insertInstructor(legacyId: string) {
    return insertId(
      "insert into instructors (legacy_id, city_id, full_name) values ($1, $2, 'Test Instructor')",
      [legacyId, ids.city],
    );
  }

  function insertStudent(legacyId: string) {
    return insertId(
      "insert into students (legacy_id, city_id, first_name, last_name) values ($1, $2, 'Test', 'Student')",
      [legacyId, ids.city],
    );
  }
});
