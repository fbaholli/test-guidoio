import { describe, expect, it } from "vitest";
import {
  type AppliedMigration,
  checksumSql,
  MIGRATIONS_DIR,
  type MigrationFile,
  migrationVersion,
  planMigrations,
  readMigrationFiles,
} from "../../src/db/migrate.js";

function file(version: string, sql = `-- ${version}`): MigrationFile {
  return { version, sql, checksum: checksumSql(sql) };
}

function appliedFrom(migration: MigrationFile): AppliedMigration {
  return { version: migration.version, checksum: migration.checksum };
}

const first = file("001_extensions");
const second = file("002_core_tables");
const third = file("003_bookings");

describe("planMigrations", () => {
  it("applies every file in order on an empty database", () => {
    const plan = planMigrations([third, first, second], []);
    expect(plan).toEqual({ ok: true, pending: [first, second, third] });
  });

  it("applies only the files that haven't run yet", () => {
    const plan = planMigrations([first, second, third], [appliedFrom(first)]);
    expect(plan).toEqual({ ok: true, pending: [second, third] });
  });

  it("has nothing to do when every file has run", () => {
    const plan = planMigrations([first, second], [appliedFrom(first), appliedFrom(second)]);
    expect(plan).toEqual({ ok: true, pending: [] });
  });

  it.each([
    [
      "an applied file was edited",
      [file("001_extensions", "-- edited"), second],
      [appliedFrom(first)],
      "001_extensions was edited after it was applied; add a new migration instead",
    ],
    [
      "an applied file is missing",
      [second],
      [appliedFrom(first)],
      "001_extensions was applied but its file is missing",
    ],
    [
      "a new file is numbered before an applied one",
      [first, second, third],
      [appliedFrom(first), appliedFrom(third)],
      "002_core_tables sorts before the already-applied 003_bookings; give it a later number",
    ],
    [
      "two files share a number",
      [first, file("002_core_tables"), file("002_bookings")],
      [],
      "002_core_tables and 002_bookings share the number 002",
    ],
  ])("refuses to run when %s", (_case, files, applied, problem) => {
    const plan = planMigrations(files, applied);
    expect(plan).toEqual({ ok: false, problems: [problem] });
  });
});

describe("migrationVersion", () => {
  it.each([
    ["001_extensions.sql", "001_extensions"],
    ["004_migration_bookkeeping.sql", "004_migration_bookkeeping"],
    ["1_extensions.sql", undefined],
    ["001-extensions.sql", undefined],
    ["001_Extensions.sql", undefined],
    ["001_extensions.SQL", undefined],
    ["001_extensions.sql.bak", undefined],
  ])("%s → %s", (fileName, expected) => {
    expect(migrationVersion(fileName)).toBe(expected);
  });
});

describe("checksumSql", () => {
  it("ignores Windows line endings", () => {
    expect(checksumSql("create table a ();\r\nselect 1;\r\n")).toBe(
      checksumSql("create table a ();\nselect 1;\n"),
    );
  });

  it("changes when the content changes", () => {
    expect(checksumSql("select 1;")).not.toBe(checksumSql("select 2;"));
  });
});

describe("the repository's migrations", () => {
  it("are well named and plan cleanly from an empty database", async () => {
    const files = await readMigrationFiles(MIGRATIONS_DIR);
    const plan = planMigrations(files, []);

    expect(plan.ok).toBe(true);
    expect(files.map((migration) => migration.version)).toContain("001_extensions");
  });
});
