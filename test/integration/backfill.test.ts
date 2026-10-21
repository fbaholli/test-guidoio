import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import {
  type BackfillOptions,
  type BackfillResult,
  runBackfill,
  SimulatedCrash,
} from "../../src/migrate/backfill.js";
import { ROME_TIME_ZONE } from "../../src/normalize/context.js";
import { DEFAULT_EXPORT_PATH } from "../../src/seed/json-export.js";
import { COLLECTIONS } from "../../src/source/collections.js";
import { createJsonReader } from "../../src/source/json-reader.js";
import { snapshot } from "../support/snapshot.js";
import { createTestDatabase, type TestDatabase } from "../support/test-database.js";

const silent = createLogger("silent");

async function backfill(
  t: TestDatabase,
  overrides: Partial<BackfillOptions> = {},
): Promise<BackfillResult> {
  return runBackfill(t.pool, {
    reader: await createJsonReader(DEFAULT_EXPORT_PATH),
    batchSize: 500,
    dryRun: false,
    resume: false,
    timeZone: ROME_TIME_ZONE,
    logger: silent,
    ...overrides,
  });
}

describe("backfill from the JSON export", () => {
  let t: TestDatabase;
  let first: BackfillResult;
  let second: BackfillResult;

  beforeAll(async () => {
    t = await createTestDatabase();
    first = await backfill(t);
    second = await backfill(t);
  });

  afterAll(async () => {
    await t.drop();
  });

  it("rejects exactly the expected fixtures, each with its reason", () => {
    const reasons = Object.fromEntries(first.rejects.map((r) => [r.legacyId, r.reason]));
    expect(reasons).toEqual({
      bk_orphan_student: "ORPHAN_STUDENT",
      bk_orphan_instructor: "ORPHAN_INSTRUCTOR",
      bk_overlap_b: "OVERLAP_INSTRUCTOR",
      bk_student_overlap: "OVERLAP_STUDENT",
      bk_date_garbage: "INVALID_DATE",
      bk_dst_gap: "DST_GAP",
      bk_status_unknown: "INVALID_STATUS",
      bk_bad_duration: "INVALID_DURATION",
    });
  });

  it.each([
    ["bk_overlap_b", "bk_overlap_a"],
    ["bk_student_overlap", "bk_student_base"],
  ])("names the booking that already holds %s's slot", (legacyId, holder) => {
    expect(first.rejects.find((r) => r.legacyId === legacyId)?.detail).toContain(holder);
  });

  it("imports everything else", async () => {
    const counts = await t.pool.query(
      `select (select count(*) from cities)::int as cities, (select count(*) from pickup_points)::int as pickup_points,
              (select count(*) from instructors)::int as instructors, (select count(*) from students)::int as students,
              (select count(*) from bookings)::int as bookings, (select count(*) from legacy_id_map where entity = 'student')::int as student_ids`,
    );
    // 316 student docs, 10 of them second sign-ups; 2,193 bookings, 8 of them rejected.
    expect(counts.rows[0]).toEqual({
      cities: 3,
      pickup_points: 12,
      instructors: 19,
      students: 306,
      bookings: 2185,
      student_ids: 316,
    });
  });

  it("lands every imported §3.2 fixture as expected", async () => {
    const { rows } = await t.pool.query(
      `select b.legacy_id, s.legacy_id as student, b.status, b.price_cents,
              extract(epoch from b.ends_at - b.starts_at)::int / 60 as minutes, b.starts_at,
              b.deleted_at is not null as deleted,
              (select count(*) from booking_events e where e.booking_id = b.id)::int as events
       from bookings b join students s on s.id = b.student_id
       where b.legacy_id not like 'bk\\_0%' order by b.legacy_id`,
    );
    const byId = Object.fromEntries(rows.map((row) => [row.legacy_id, row]));
    const at = (id: string) => (byId[id]?.starts_at as Date | undefined)?.toISOString();

    // 29 booking fixtures in §3.2, 8 of them rejected.
    expect(Object.keys(byId)).toHaveLength(21);
    expect(byId.bk_overlap_a?.status).toBe("confirmed");
    expect(byId.bk_overlap_cancelled?.status).toBe("cancelled");
    expect([byId.bk_adjacent_1?.status, byId.bk_adjacent_2?.status]).toEqual([
      "confirmed",
      "confirmed",
    ]);
    expect(
      ["bk_date_timestamp", "bk_date_iso", "bk_date_it_string", "bk_date_epoch"].map(at),
    ).toEqual(Array(4).fill("2026-10-21T12:30:00.000Z"));
    expect(at("bk_dst_ambiguous")).toBe("2026-10-25T00:30:00.000Z");
    expect([1, 2, 3, 4].map((n) => byId[`bk_status_variants_${n}`]?.status)).toEqual([
      "cancelled",
      "cancelled",
      "confirmed",
      "no_show",
    ]);
    expect(byId.bk_no_duration?.minutes).toBe(60);
    expect(byId.bk_price_string?.price_cents).toBe(4550);
    expect(byId.bk_dup_student_ref?.student).toBe("st_dup_rossi_a");
    expect(byId.bk_history_nested?.events).toBe(3);
    expect(byId.bk_deleted?.deleted).toBe(true);
    expect(byId.bk_denorm_drift).toBeDefined();
    expect(byId.bk_unknown_fields).toBeDefined();
  });

  it("merges the Rossi sign-ups into one student with both ids mapped to it", async () => {
    const { rows } = await t.pool.query(
      `select s.legacy_id, s.email, s.phone_e164, s.tax_code,
              array(select m.legacy_id from legacy_id_map m where m.entity = 'student' and m.new_id = s.id order by 1) as ids
       from students s where s.legacy_id like 'st\\_dup\\_rossi%'`,
    );
    expect(rows).toEqual([
      {
        legacy_id: "st_dup_rossi_a",
        email: "Mario.Rossi@Example.com",
        phone_e164: "+393471112233",
        tax_code: "RSSMRA85M01F205Z",
        ids: ["st_dup_rossi_a", "st_dup_rossi_b"],
      },
    ]);
  });

  it("stores phones in E.164, or not at all", async () => {
    const { rows } = await t.pool.query(
      "select legacy_id, phone_e164 from students where legacy_id like 'st\\_%phone%' order by 1",
    );
    expect(rows).toEqual([
      { legacy_id: "st_bad_phone", phone_e164: null },
      { legacy_id: "st_phone_formats_1", phone_e164: "+393331234567" },
      { legacy_id: "st_phone_formats_2", phone_e164: "+393331234567" },
      { legacy_id: "st_phone_formats_3", phone_e164: "+393331234567" },
    ]);
  });

  it("records each fixture's warnings, and none for the clean generated data", async () => {
    const { rows } = await t.pool.query(
      `select legacy_id, code from migration_warnings where run_id = $1 and code <> 'DUPLICATE_MERGED'
       order by legacy_id, code`,
      [first.runId],
    );
    expect(rows.map((row) => `${row.legacy_id} ${row.code}`)).toEqual([
      "bk_date_epoch DATE_PARSED_FROM_NUMBER",
      "bk_date_it_string DATE_PARSED_FROM_STRING",
      "bk_denorm_drift DENORM_DRIFT",
      "bk_dst_ambiguous DATE_AMBIGUOUS",
      "bk_dst_ambiguous DATE_PARSED_FROM_STRING",
      "bk_no_duration DURATION_DEFAULTED",
      "bk_price_string PRICE_PARSED_FROM_STRING",
      "bk_status_variants_1 STATUS_NORMALIZED",
      "bk_status_variants_2 STATUS_NORMALIZED",
      "bk_status_variants_3 STATUS_NORMALIZED",
      "bk_status_variants_4 STATUS_NORMALIZED",
      "bk_unknown_fields UNKNOWN_FIELDS",
      "st_bad_phone PHONE_UNPARSEABLE",
      "st_phone_formats_1 PHONE_NORMALIZED",
      "st_phone_formats_2 PHONE_NORMALIZED",
    ]);
    expect(first.stats.students?.warnings.DUPLICATE_MERGED).toBe(10);
  });

  it.each(COLLECTIONS)("changes nothing in %s on the second run", (collection) => {
    const before = first.stats[collection];
    const after = second.stats[collection];
    expect(after).toMatchObject({ inserted: 0, updated: 0, events: 0, rejected: before?.rejected });
    expect(after?.unchanged).toBe(
      (before?.inserted ?? 0) + (before?.updated ?? 0) + (before?.unchanged ?? 0),
    );
  });

  it("finishes both runs and keeps their stats", async () => {
    const { rows } = await t.pool.query(
      "select finished_at is not null as finished, dry_run, stats from migration_runs order by started_at",
    );
    expect(rows.map((row) => [row.finished, row.dry_run])).toEqual([
      [true, false],
      [true, false],
    ]);
    expect(rows[0]?.stats).toEqual(first.stats);
  });
});

describe("resume after a crash", () => {
  // With batches of 200: cities, pickup points and instructors take a batch each, students 2
  // and bookings 11. Batch 4 is mid-students, batch 7 is mid-bookings.
  it.each([4, 7])(
    "finishes as one uninterrupted run would, after a crash at batch %i",
    async (crashAt) => {
      const crashed = await createTestDatabase();
      const straight = await createTestDatabase();
      try {
        await expect(
          backfill(crashed, { batchSize: 200, stopAfterBatches: crashAt }),
        ).rejects.toThrow(SimulatedCrash);
        const resumed = await backfill(crashed, { batchSize: 200, resume: true });
        const uninterrupted = await backfill(straight, { batchSize: 200 });

        expect(resumed.resumed).toBe(true);
        expect(resumed.stats).toEqual(uninterrupted.stats);
        expect(await snapshot(crashed.pool)).toEqual(await snapshot(straight.pool));
      } finally {
        await crashed.drop();
        await straight.drop();
      }
    },
  );
});

describe("dry run", () => {
  it("rolls everything back but keeps its run record and the same stats", async () => {
    const t = await createTestDatabase();
    try {
      const dry = await backfill(t, { dryRun: true });
      const { rows } = await t.pool.query(
        `select (select count(*) from bookings)::int as bookings, (select count(*) from migration_rejects)::int as rejects,
                (select count(*) from migration_runs where dry_run and finished_at is not null)::int as runs`,
      );
      expect(rows[0]).toEqual({ bookings: 0, rejects: 0, runs: 1 });
      expect(dry.stats.bookings?.inserted).toBe(2185);
      expect(dry.rejects).toHaveLength(8);
    } finally {
      await t.drop();
    }
  });
});
