import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import { runBackfill } from "../../src/migrate/backfill.js";
import {
  type SyncSession,
  startSyncSession,
  stopSyncSession,
  syncDocument,
} from "../../src/migrate/sync.js";
import { ROME_TIME_ZONE } from "../../src/normalize/context.js";
import { DEFAULT_EXPORT_PATH } from "../../src/seed/json-export.js";
import type { CollectionName } from "../../src/source/collections.js";
import { createJsonReader } from "../../src/source/json-reader.js";
import { readAll } from "../../src/source/read-all.js";
import type { RawDoc } from "../../src/source/types.js";
import { createTestDatabase, type TestDatabase } from "../support/test-database.js";

const silent = createLogger("silent");
const HOUR = 3_600_000;

describe("live sync", () => {
  let backfilled: TestDatabase;
  let source: Record<"students" | "bookings", RawDoc[]>;

  beforeAll(async () => {
    const reader = await createJsonReader(DEFAULT_EXPORT_PATH);
    source = {
      students: await readAll(reader, "students"),
      bookings: await readAll(reader, "bookings"),
    };
    backfilled = await createTestDatabase();
    await runBackfill(backfilled.pool, {
      reader,
      batchSize: 500,
      dryRun: false,
      resume: false,
      timeZone: ROME_TIME_ZONE,
      logger: silent,
    });
    await backfilled.close();
  });

  afterAll(async () => {
    await backfilled.drop();
  });

  /** A copy of the backfilled database and a sync session that knows every student doc. */
  async function withSync(run: (t: TestDatabase, session: SyncSession) => Promise<void>) {
    const t = await createTestDatabase({ copyOf: backfilled.name });
    try {
      const session = await startSyncSession(t.pool, {
        source: "json",
        timeZone: ROME_TIME_ZONE,
        logger: silent,
        students: source.students,
      });
      await run(t, session);
      await stopSyncSession(t.pool, session);
    } finally {
      await t.drop();
    }
  }

  function sourceDoc(collection: "students" | "bookings", id: string): RawDoc {
    const doc = source[collection].find((candidate) => candidate.id === id);
    if (!doc) throw new Error(`No ${collection} doc ${id}`);
    return doc;
  }

  /** The same doc, edited and saved again `hoursLater` after its last update. */
  function edited(doc: RawDoc, changes: Record<string, unknown>, hoursLater = 1): RawDoc {
    return {
      id: doc.id,
      updateTime: new Date(doc.updateTime.getTime() + hoursLater * HOUR),
      data: { ...doc.data, ...changes },
    };
  }

  const upsert = (collection: CollectionName, doc: RawDoc) => ({
    kind: "upsert" as const,
    collection,
    doc,
  });

  async function value<T>(t: TestDatabase, sql: string): Promise<T> {
    return (await t.pool.query(sql)).rows[0]?.value as T;
  }

  it("keeps the newer version when a stale event arrives after it", async () => {
    await withSync(async (t, session) => {
      const original = sourceDoc("bookings", "bk_00042");
      const newer = edited(original, { price: 99 });

      expect((await syncDocument(t.pool, session, upsert("bookings", newer))).result).toBe(
        "updated",
      );
      expect((await syncDocument(t.pool, session, upsert("bookings", original))).result).toBe(
        "unchanged",
      );
      expect(
        await value(t, "select price_cents as value from bookings where legacy_id = 'bk_00042'"),
      ).toBe(9900);
    });
  });

  it("ignores the same event delivered twice", async () => {
    await withSync(async (t, session) => {
      const newer = edited(sourceDoc("bookings", "bk_00042"), { notes: "Ripasso rotatorie" });
      const first = await syncDocument(t.pool, session, upsert("bookings", newer));
      const again = await syncDocument(t.pool, session, upsert("bookings", newer));
      expect([first.result, again.result]).toEqual(["updated", "unchanged"]);
    });
  });

  it("soft-deletes a doc removed from the source, which frees its slot", async () => {
    await withSync(async (t, session) => {
      const deleted = await syncDocument(t.pool, session, {
        kind: "delete",
        collection: "bookings",
        legacyId: "bk_overlap_a",
      });
      // bk_overlap_b was rejected by the backfill because bk_overlap_a held the slot.
      const retried = await syncDocument(
        t.pool,
        session,
        upsert("bookings", edited(sourceDoc("bookings", "bk_overlap_b"), {})),
      );

      expect(deleted.result).toBe("soft-deleted");
      expect(
        await value(
          t,
          "select deleted_at is not null as value from bookings where legacy_id = 'bk_overlap_a'",
        ),
      ).toBe(true);
      expect(retried.result).toBe("inserted");
      expect(session.stats.bookings?.softDeleted).toBe(1);
    });
  });

  it("re-merges an edited duplicate into the surviving student instead of overwriting it", async () => {
    await withSync(async (t, session) => {
      const outcome = await syncDocument(
        t.pool,
        session,
        upsert(
          "students",
          edited(sourceDoc("students", "st_dup_rossi_b"), { phone: "+39 347 999 8877" }),
        ),
      );
      const rows = (
        await t.pool.query(
          `select s.legacy_id, s.first_name, s.phone_e164,
                  (select count(*)::int from students) as students,
                  (select st.legacy_id from legacy_id_map m join students st on st.id = m.new_id
                   where m.entity = 'student' and m.legacy_id = 'st_dup_rossi_b') as b_points_to
           from students s where s.legacy_id = 'st_dup_rossi_a'`,
        )
      ).rows;

      expect(outcome).toEqual({ legacyId: "st_dup_rossi_a", result: "updated" });
      expect(rows).toEqual([
        {
          legacy_id: "st_dup_rossi_a",
          first_name: "Mario",
          phone_e164: "+393479998877",
          students: 306,
          b_points_to: "st_dup_rossi_a",
        },
      ]);
    });
  });

  it("inserts a new booking from the app, and rejects one that overlaps it", async () => {
    await withSync(async (t, session) => {
      const template = sourceDoc("bookings", "bk_overlap_a");
      const lesson = (id: string, startAt: string): RawDoc => ({
        id,
        updateTime: new Date("2026-11-01T10:00:00Z"),
        data: {
          ...template.data,
          studentId: id === "bk_live_1" ? "st_fx_01" : "st_fx_02",
          startAt: new Date(startAt),
          history: [],
        },
      });

      const first = await syncDocument(
        t.pool,
        session,
        upsert("bookings", lesson("bk_live_1", "2026-11-20T09:00:00Z")),
      );
      const clash = await syncDocument(
        t.pool,
        session,
        upsert("bookings", lesson("bk_live_2", "2026-11-20T09:30:00Z")),
      );
      const reject = (
        await t.pool.query(
          "select reason_code, reason_detail from migration_rejects where run_id = $1",
          [session.runId],
        )
      ).rows;

      expect(first.result).toBe("inserted");
      expect(clash).toEqual({
        legacyId: "bk_live_2",
        result: "rejected",
        reason: "OVERLAP_INSTRUCTOR",
      });
      expect(reject).toEqual([
        {
          reason_code: "OVERLAP_INSTRUCTOR",
          reason_detail: "overlaps bk_live_1 (same instructor)",
        },
      ]);
    });
  });

  it("records the session as a finished sync run with its stats", async () => {
    let runId = "";
    await withSync(async (t, session) => {
      runId = session.runId;
      await syncDocument(
        t.pool,
        session,
        upsert("bookings", edited(sourceDoc("bookings", "bk_00042"), { paid: true })),
      );
      await stopSyncSession(t.pool, session);
      const run = (
        await t.pool.query(
          "select mode, finished_at is not null as finished, stats from migration_runs where id = $1",
          [runId],
        )
      ).rows[0];
      expect(run).toMatchObject({ mode: "sync", finished: true });
      expect(run?.stats.bookings.updated).toBe(1);
    });
  });
});
