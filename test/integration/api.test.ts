import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import { firestoreBookings } from "../../src/api/repos/firestore.js";
import { postgresBookings } from "../../src/api/repos/postgres.js";
import { emptyShadowStats, shadowBookings } from "../../src/api/repos/shadow.js";
import { createLogger } from "../../src/logger.js";
import { runBackfill } from "../../src/migrate/backfill.js";
import { ROME_TIME_ZONE } from "../../src/normalize/context.js";
import { DEFAULT_EXPORT_PATH } from "../../src/seed/json-export.js";
import { readerDocumentStore } from "../../src/source/document-store.js";
import { createJsonReader } from "../../src/source/json-reader.js";
import { createTestDatabase, type TestDatabase } from "../support/test-database.js";

// The JSON export stands in for Firestore: same docs, same normaliser, no emulator needed.

describe("bookings API", () => {
  let backfilled: TestDatabase;

  beforeAll(async () => {
    backfilled = await createTestDatabase();
    await runBackfill(backfilled.pool, {
      reader: await createJsonReader(DEFAULT_EXPORT_PATH),
      batchSize: 500,
      dryRun: false,
      resume: false,
      timeZone: ROME_TIME_ZONE,
      logger: createLogger("silent"),
    });
    await backfilled.close();
  });

  afterAll(async () => {
    await backfilled.drop();
  });

  /** An app over its own copy of the backfilled database, with its logs captured. */
  async function withApp(
    run: (ctx: Awaited<ReturnType<typeof makeApp>>) => Promise<void>,
    options: { production?: boolean } = {},
  ) {
    const t = await createTestDatabase({ copyOf: backfilled.name });
    const ctx = await makeApp(t, options.production ?? false);
    try {
      await run(ctx);
    } finally {
      await ctx.app.close();
      await t.drop();
    }
  }

  async function makeApp(t: TestDatabase, production: boolean) {
    const lines: string[] = [];
    const logger = createLogger("info", { write: (line: string) => lines.push(line) });
    const postgres = postgresBookings(t.db);
    const firestore = firestoreBookings(
      readerDocumentStore(await createJsonReader(DEFAULT_EXPORT_PATH)),
      ROME_TIME_ZONE,
    );
    const shadowStats = emptyShadowStats();
    const app = await buildApp({
      logger,
      shadowStats,
      readSource: "postgres",
      allowHeaderOverride: !production,
      readers: {
        postgres,
        firestore,
        shadow: shadowBookings(firestore, postgres, logger, shadowStats),
      },
      writer: postgres,
    });
    const logs = () => lines.map((line): Record<string, unknown> => JSON.parse(line));
    return { app, t, logs, lines };
  }

  const get = (app: Awaited<ReturnType<typeof makeApp>>["app"], url: string, source?: string) =>
    app.inject({ method: "GET", url, headers: source ? { "x-read-source": source } : {} });

  it("answers the health check", async () => {
    await withApp(async ({ app }) => {
      const response = await get(app, "/health");
      expect([response.statusCode, response.json()]).toEqual([200, { status: "ok" }]);
    });
  });

  it.each(["bk_00042", "bk_dup_student_ref", "bk_date_it_string", "bk_deleted"])(
    "returns %s the same from Firestore and from Postgres",
    async (legacyId) => {
      await withApp(async ({ app }) => {
        const fromFirestore = await get(app, `/v1/bookings/${legacyId}`, "firestore");
        const fromPostgres = await get(app, `/v1/bookings/${legacyId}`, "postgres");
        expect(fromFirestore.statusCode).toBe(200);
        expect(fromFirestore.headers["x-read-source"]).toBe("firestore");
        expect(fromPostgres.json()).toEqual(fromFirestore.json());
      });
    },
  );

  it("speaks legacy ids, with merged students as their surviving id", async () => {
    await withApp(async ({ app }) => {
      const body = (await get(app, "/v1/bookings/bk_dup_student_ref", "postgres")).json();
      expect(body).toMatchObject({
        id: "bk_dup_student_ref",
        studentId: "st_dup_rossi_a",
        instructorId: "in_fx_04",
      });
    });
  });

  it.each(["postgres", "firestore", "shadow"])(
    "answers 404 for an unknown booking (%s)",
    async (source) => {
      await withApp(async ({ app }) => {
        const response = await get(app, "/v1/bookings/bk_nope", source);
        expect([response.statusCode, response.json().code]).toEqual([404, "NOT_FOUND"]);
      });
    },
  );

  it("lists an instructor's week the same from both stores", async () => {
    await withApp(async ({ app }) => {
      const url =
        "/v1/instructors/in_001/bookings?from=2026-09-14T00:00:00%2B02:00&to=2026-09-21T00:00:00%2B02:00";
      const fromFirestore = (await get(app, url, "firestore")).json();
      const fromPostgres = (await get(app, url, "postgres")).json();
      expect(fromPostgres.bookings.length).toBeGreaterThan(5);
      expect(fromPostgres).toEqual(fromFirestore);
    });
  });

  it.each([
    [
      "an unknown instructor",
      "/v1/instructors/in_nope/bookings?from=2026-09-14T00:00:00Z&to=2026-09-21T00:00:00Z",
      404,
    ],
    [
      "a window ending before it starts",
      "/v1/instructors/in_001/bookings?from=2026-09-21T00:00:00Z&to=2026-09-14T00:00:00Z",
      400,
    ],
    [
      "a window without an offset",
      "/v1/instructors/in_001/bookings?from=2026-09-14&to=2026-09-21",
      400,
    ],
  ])("answers %s with %i", async (_case, url, status) => {
    await withApp(async ({ app }) => {
      expect((await get(app, url)).statusCode).toBe(status);
    });
  });

  describe("POST /v1/bookings", () => {
    const lesson = {
      studentId: "st_fx_09",
      instructorId: "in_fx_01",
      startsAt: "2026-11-20T10:00:00+01:00",
      durationMin: 60,
      priceCents: 4500,
    };
    const post = (app: Awaited<ReturnType<typeof makeApp>>["app"], payload: object) =>
      app.inject({ method: "POST", url: "/v1/bookings", payload });

    it("returns 409 for a lesson that overlaps a confirmed one", async () => {
      await withApp(async ({ app }) => {
        // bk_overlap_a: instructor in_fx_01, 15 Sep 10:00–11:00 Rome, confirmed.
        const response = await post(app, { ...lesson, startsAt: "2026-09-15T10:30:00+02:00" });
        expect([response.statusCode, response.json().code]).toEqual([409, "BOOKING_OVERLAP"]);
      });
    });

    it("returns 409 when the student is already in a lesson, even with another instructor", async () => {
      await withApp(async ({ app }) => {
        // bk_student_base: student st_fx_05, 17 Sep 10:00–11:00 Rome.
        const response = await post(app, {
          ...lesson,
          studentId: "st_fx_05",
          instructorId: "in_fx_03",
          startsAt: "2026-09-17T10:15:00+02:00",
        });
        expect(response.statusCode).toBe(409);
      });
    });

    it.each([
      ["an unknown student", { studentId: "st_nobody" }, 422, "UNKNOWN_REFERENCE"],
      ["an unknown pickup point", { pickupPointId: "pp_nowhere" }, 422, "UNKNOWN_REFERENCE"],
      ["a 600-minute lesson", { durationMin: 600 }, 400, "INVALID_REQUEST"],
      ["a negative price", { priceCents: -1 }, 400, "INVALID_REQUEST"],
      ["an unexpected field", { colour: "red" }, 400, "INVALID_REQUEST"],
    ])("rejects %s", async (_case, change, status, code) => {
      await withApp(async ({ app }) => {
        const response = await post(app, { ...lesson, ...change });
        expect([response.statusCode, response.json().code]).toEqual([status, code]);
      });
    });

    it("creates a booking in Postgres with an api_ id that reads back by that id", async () => {
      await withApp(async ({ app, t }) => {
        const created = await post(app, lesson);
        const body = created.json();
        const readBack = await get(app, `/v1/bookings/${body.id}`, "postgres");
        const events = await t.pool.query(
          "select e.status, e.source from booking_events e join bookings b on b.id = e.booking_id where b.legacy_id = $1",
          [body.id],
        );

        expect(created.statusCode).toBe(201);
        expect(body).toMatchObject({
          studentId: "st_fx_09",
          instructorId: "in_fx_01",
          startsAt: "2026-11-20T09:00:00.000Z",
          endsAt: "2026-11-20T10:00:00.000Z",
          status: "booked",
          priceCents: 4500,
        });
        expect(body.id).toMatch(/^api_[0-9a-f-]{36}$/);
        expect(created.headers.location).toBe(`/v1/bookings/${body.id}`);
        expect(readBack.json()).toEqual(body);
        expect(events.rows).toEqual([{ status: "booked", source: "api" }]);
      });
    });
  });

  describe("shadow reads", () => {
    it("serve Firestore, and log a diff for a record changed only in Postgres", async () => {
      await withApp(async ({ app, t, logs, lines }) => {
        await t.pool.query(
          "update bookings set price_cents = price_cents + 1 where legacy_id = 'bk_00042'",
        );
        const fromFirestore = (await get(app, "/v1/bookings/bk_00042", "firestore")).json();
        const shadow = await get(app, "/v1/bookings/bk_00042", "shadow");
        const stats = (await get(app, "/debug/shadow-stats")).json();
        const diffs = logs().filter((entry) => entry.msg === "shadow_diff");

        expect(shadow.json()).toEqual(fromFirestore);
        expect(diffs.map(({ legacyId, fields }) => ({ legacyId, fields }))).toEqual([
          { legacyId: "bk_00042", fields: ["priceCents"] },
        ]);
        expect(stats).toEqual({
          compared: 1,
          matched: 0,
          differed: 1,
          errors: 0,
          fields: { priceCents: 1 },
        });
        // Field names only: neither price appears in the log.
        const diffLine = lines.find((line) => line.includes("shadow_diff")) ?? "";
        expect(diffLine).not.toContain(String(fromFirestore.priceCents));
      });
    });

    it("count a matching record as matched", async () => {
      await withApp(async ({ app }) => {
        await get(app, "/v1/bookings/bk_00042", "shadow");
        expect((await get(app, "/debug/shadow-stats")).json()).toMatchObject({
          compared: 1,
          matched: 1,
          differed: 0,
        });
      });
    });
  });

  it("ignores the x-read-source header in production", async () => {
    await withApp(
      async ({ app }) => {
        const response = await get(app, "/v1/bookings/bk_00042", "firestore");
        expect(response.headers["x-read-source"]).toBe("postgres");
      },
      { production: true },
    );
  });
});
