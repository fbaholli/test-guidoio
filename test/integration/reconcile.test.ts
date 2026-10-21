import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import { runBackfill } from "../../src/migrate/backfill.js";
import { type ReconcileResult, reconcile } from "../../src/migrate/reconcile.js";
import { ROME_TIME_ZONE } from "../../src/normalize/context.js";
import { DEFAULT_EXPORT_PATH } from "../../src/seed/json-export.js";
import { createJsonReader } from "../../src/source/json-reader.js";
import type { SourceReader } from "../../src/source/types.js";
import { createTestDatabase, type TestDatabase } from "../support/test-database.js";

const reader = () => createJsonReader(DEFAULT_EXPORT_PATH);

/** The same source, minus some docs: as if they were hard-deleted in Firestore. */
async function readerWithout(ids: string[]): Promise<SourceReader> {
  const inner = await reader();
  return {
    ...inner,
    readPage: async (collection, afterId, limit) =>
      (await inner.readPage(collection, afterId, limit)).filter((doc) => !ids.includes(doc.id)),
  };
}

describe("reconciliation after a backfill", () => {
  // Backfilled once, then closed and used as a template: every test gets its own copy to change.
  let backfilled: TestDatabase;

  beforeAll(async () => {
    backfilled = await createTestDatabase();
    await runBackfill(backfilled.pool, {
      reader: await reader(),
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

  async function reconcileAfter(
    change: string | undefined,
    source: Promise<SourceReader> = reader(),
  ): Promise<ReconcileResult> {
    const copy = await createTestDatabase({ copyOf: backfilled.name });
    try {
      if (change) await copy.pool.query(change);
      return await reconcile(copy.pool, await source, ROME_TIME_ZONE);
    } finally {
      await copy.drop();
    }
  }

  it("is clean: counts, every checksum and the monthly totals match", async () => {
    const result = await reconcileAfter(undefined);
    expect(result.clean).toBe(true);
    expect(result.entities.bookings).toMatchObject({
      sourceDocs: 2193,
      pgRows: 2185,
      matched: 2185,
      countsMatch: true,
    });
    expect(result.entities.bookings.expectedGaps).toHaveLength(8);
    expect(result.entities.students).toMatchObject({
      sourceDocs: 316,
      pgRows: 306,
      mergedDuplicates: 10,
      matched: 306,
    });
    expect(result.differingMonths).toEqual([]);
  });

  it("catches one changed price, naming the record and the field", async () => {
    const result = await reconcileAfter(
      "update bookings set price_cents = price_cents + 1 where legacy_id = 'bk_00042'",
    );
    expect(result.clean).toBe(false);
    expect(result.entities.bookings.mismatched).toEqual([
      { legacyId: "bk_00042", fields: ["priceCents"] },
    ]);
  });

  it("catches a booking missing from Postgres", async () => {
    const result = await reconcileAfter("delete from bookings where legacy_id = 'bk_00042'");
    expect(result.clean).toBe(false);
    expect(result.entities.bookings.missingInPg).toEqual(["bk_00042"]);
  });

  it("leaves out bookings created through the API", async () => {
    const result = await reconcileAfter(
      `insert into bookings (legacy_id, student_id, instructor_id, starts_at, ends_at, status, source)
       select 'api_test', s.id, i.id, '2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', 'booked', 'api'
       from students s, instructors i where s.legacy_id = 'st_fx_01' and i.legacy_id = 'in_fx_01'`,
    );
    expect(result.clean).toBe(true);
    expect(result.apiRows).toBe(1);
  });

  it("accepts a booking hard-deleted in the source and soft-deleted here", async () => {
    const result = await reconcileAfter(
      "update bookings set deleted_at = now() where legacy_id = 'bk_00042'",
      readerWithout(["bk_00042"]),
    );
    expect(result.entities.bookings.deletedInSource).toEqual(["bk_00042"]);
    expect(result.clean).toBe(true);
  });

  it("catches a live booking that the source no longer has", async () => {
    const result = await reconcileAfter(undefined, readerWithout(["bk_00042"]));
    expect(result.entities.bookings.extraInPg).toEqual(["bk_00042"]);
    expect(result.clean).toBe(false);
  });
});
