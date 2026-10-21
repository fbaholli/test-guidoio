import { describe, expect, it } from "vitest";
import { resetRefusal } from "../../src/db/reset.js";

const url = (database: string) => `postgres://driving:pw@macmini.local:54329/${database}`;

describe("resetRefusal", () => {
  it.each([
    ["the dev database", url("driving_school")],
    ["a throwaway test database", url("ds_test_3f9a")],
  ])("allows %s", (_case, databaseUrl) => {
    expect(resetRefusal(databaseUrl, "development")).toBeUndefined();
  });

  it.each([
    ["another project's database", url("hoc"), "development"],
    ["the maintenance database", url("postgres"), "test"],
    ["a database whose name only contains ours", url("old_driving_school"), "development"],
    ["any database in production", url("driving_school"), "production"],
  ])("refuses %s", (_case, databaseUrl, nodeEnv) => {
    expect(resetRefusal(databaseUrl, nodeEnv)).toMatch(/^refusing to reset/);
  });
});
