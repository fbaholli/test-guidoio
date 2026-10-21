import { readFile } from "node:fs/promises";
import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { parseSeedArgs } from "../../src/seed/args.js";
import { buildSeedDataset, EXPORT_UPDATE_TIME } from "../../src/seed/dataset.js";
import { MAX_BATCH_WRITES, toFirestoreFields } from "../../src/seed/firestore-writer.js";
import { DEFAULT_EXPORT_PATH, toExportJson } from "../../src/seed/json-export.js";
import { SeedTimestamp } from "../../src/seed/types.js";
import { COLLECTIONS } from "../../src/source/collections.js";
import { exportFileSchema } from "../../src/source/export-format.js";
import { connectionProblem } from "../../src/source/firestore-client.js";
import { chunk } from "../../src/util/chunk.js";

const json = toExportJson(buildSeedDataset(), EXPORT_UPDATE_TIME);
const exported = exportFileSchema.parse(JSON.parse(json));
const exportedBooking = (id: string) => {
  const doc = exported.collections.bookings.find((candidate) => candidate.id === id);
  if (!doc) throw new Error(`No exported booking ${id}`);
  return doc;
};

describe("JSON export", () => {
  it("matches the committed test/fixtures/export.json (run `pnpm seed --target=json`)", async () => {
    expect(await readFile(DEFAULT_EXPORT_PATH, "utf8")).toBe(json);
  });

  it("lists the collections in foreign-key order", () => {
    expect(Object.keys(exported.collections)).toEqual([...COLLECTIONS]);
  });

  it("gives every doc the same update time", () => {
    const docs = COLLECTIONS.flatMap((name) => exported.collections[name]);
    expect(new Set(docs.map((doc) => doc._updateTime))).toEqual(new Set([EXPORT_UPDATE_TIME]));
  });

  it("wraps Firestore timestamps, including those nested in history", () => {
    const doc = exportedBooking("bk_history_nested");
    expect(exportedBooking("bk_date_timestamp").data.startAt).toEqual({
      $timestamp: "2026-10-21T12:30:00.000Z",
    });
    expect(doc.data.history).toContainEqual({
      status: "completed",
      at: { $timestamp: "2026-09-21T10:00:00.000Z" },
      by: "istruttore",
    });
  });

  it("keeps non-timestamp dates exactly as they were", () => {
    expect(exportedBooking("bk_date_iso").data.startAt).toBe("2026-10-21T14:30:00+02:00");
    expect(exportedBooking("bk_date_epoch").data.startAt).toBe(1_792_585_800_000);
  });

  it("ends with a newline", () => {
    expect(json.endsWith("}\n")).toBe(true);
  });
});

describe("Firestore writer", () => {
  it.each([
    [0, []],
    [1, [1]],
    [500, [500]],
    [501, [500, 1]],
    [1001, [500, 500, 1]],
  ])("splits %i writes into batches of %j", (count, sizes) => {
    const items = Array.from({ length: count }, (_, i) => i);
    expect(chunk(items, MAX_BATCH_WRITES).map((part) => part.length)).toEqual(sizes);
  });

  it("turns seed timestamps into Firestore Timestamps, at any depth", () => {
    const fields = toFirestoreFields({
      startAt: new SeedTimestamp("2026-10-21T12:30:00.000Z"),
      history: [{ status: "booked", at: new SeedTimestamp("2026-09-01T08:00:00.000Z") }],
      price: "45,50",
    });

    expect(fields.startAt).toEqual(Timestamp.fromDate(new Date("2026-10-21T12:30:00Z")));
    expect(fields.history).toEqual([
      { status: "booked", at: Timestamp.fromDate(new Date("2026-09-01T08:00:00Z")) },
    ]);
    expect(fields.price).toBe("45,50");
  });
});

describe("connectionProblem", () => {
  const firestore = (overrides: Partial<Config["firestore"]>): Config["firestore"] => ({
    projectId: "demo-driving-school",
    emulatorHost: "127.0.0.1:8080",
    credentialsPath: undefined,
    ...overrides,
  });

  it.each([
    ["the emulator with its host set", firestore({}), "emulator"],
    [
      "a real project with credentials",
      firestore({ projectId: "acme-prod", emulatorHost: undefined, credentialsPath: "/sa.json" }),
      "firestore",
    ],
  ] as const)("allows %s", (_case, config, mode) => {
    expect(connectionProblem(config, mode)).toBeUndefined();
  });

  it.each([
    [
      "the emulator without its host",
      firestore({ emulatorHost: undefined }),
      "emulator",
      /not set/,
    ],
    [
      "the emulator on a real project id",
      firestore({ projectId: "acme-prod" }),
      "emulator",
      /demo-/,
    ],
    [
      "a real project while the emulator variable is set",
      firestore({ projectId: "acme-prod", credentialsPath: "/sa.json" }),
      "firestore",
      /would write to the emulator/,
    ],
    [
      "a real project without credentials",
      firestore({ projectId: "acme-prod", emulatorHost: undefined }),
      "firestore",
      /GOOGLE_APPLICATION_CREDENTIALS/,
    ],
    [
      "a real project with a demo- id",
      firestore({ emulatorHost: undefined, credentialsPath: "/sa.json" }),
      "firestore",
      /demo- id/,
    ],
  ] as const)("refuses %s", (_case, config, mode, message) => {
    expect(connectionProblem(config, mode)).toMatch(message);
  });
});

describe("parseSeedArgs", () => {
  it.each([
    [[], { target: "emulator" }],
    [["--target=json"], { target: "json" }],
    [["--", "--target=json"], { target: "json" }],
    [["--target", "firestore"], { target: "firestore" }],
    [["--target=json", "--out=/tmp/x.json"], { target: "json", out: "/tmp/x.json" }],
  ])("reads %j", (argv, expected) => {
    expect(parseSeedArgs(argv)).toEqual(expected);
  });

  it.each([[["--target=mongo"]], [["--force"]], [["json"]]])("rejects %j", (argv) => {
    expect(() => parseSeedArgs(argv)).toThrow();
  });
});
