import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import type { Logger } from "pino";
import { z } from "zod";
import { compareCodeUnits } from "../util/order.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

// Any number works as long as every migrator uses the same one: holding it makes concurrent
// `db:migrate` runs wait for each other instead of applying the same file twice.
const MIGRATION_LOCK_KEY = 815_042_133;

const MIGRATION_FILE_NAME = /^((\d{3})_[a-z0-9_]+)\.sql$/;

const CREATE_SCHEMA_MIGRATIONS = `
  create table if not exists schema_migrations (
    version text primary key,
    checksum text not null,
    applied_at timestamptz not null default now()
  )`;

const appliedRowsSchema = z.array(z.object({ version: z.string(), checksum: z.string() }));

export type MigrationFile = { version: string; checksum: string; sql: string };
export type AppliedMigration = { version: string; checksum: string };
export type MigrationPlan =
  | { ok: true; pending: MigrationFile[] }
  | { ok: false; problems: string[] };
export type MigrationRunResult = { applied: string[]; alreadyApplied: number };

/** `001_extensions.sql` → `001_extensions`; anything else → undefined. */
export function migrationVersion(fileName: string): string | undefined {
  return MIGRATION_FILE_NAME.exec(fileName)?.[1];
}

export function checksumSql(sql: string): string {
  // Normalise line endings so a Windows (CRLF) checkout doesn't look like an edited migration.
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/**
 * Decides which files still need applying. Migrations are append-only, so an applied file
 * that changed or vanished, or a new file numbered before an applied one, stops the run.
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationPlan {
  const problems: string[] = [];
  const filesByVersion = new Map(files.map((file) => [file.version, file]));

  for (const migration of applied) {
    const file = filesByVersion.get(migration.version);
    if (!file) {
      problems.push(`${migration.version} was applied but its file is missing`);
    } else if (file.checksum !== migration.checksum) {
      problems.push(
        `${migration.version} was edited after it was applied; add a new migration instead`,
      );
    }
  }

  const seenNumbers = new Map<string, string>();
  for (const file of files) {
    const number = file.version.slice(0, 3);
    const other = seenNumbers.get(number);
    if (other) problems.push(`${other} and ${file.version} share the number ${number}`);
    seenNumbers.set(number, file.version);
  }

  const appliedVersions = new Set(applied.map((migration) => migration.version));
  const lastApplied = [...appliedVersions].sort(compareCodeUnits).at(-1);
  const pending = files
    .filter((file) => !appliedVersions.has(file.version))
    .sort((a, b) => compareCodeUnits(a.version, b.version));

  for (const file of pending) {
    if (lastApplied !== undefined && file.version < lastApplied) {
      problems.push(
        `${file.version} sorts before the already-applied ${lastApplied}; give it a later number`,
      );
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, pending };
}

export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const fileNames = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    fileNames.map(async (fileName) => {
      const version = migrationVersion(fileName);
      if (!version) {
        throw new Error(`Bad migration file name "${fileName}": expected NNN_description.sql`);
      }
      const sql = await readFile(join(dir, fileName), "utf8");
      return { version, sql, checksum: checksumSql(sql) };
    }),
  );
}

export async function runMigrations(
  pool: pg.Pool,
  dir: string,
  logger: Logger,
): Promise<MigrationRunResult> {
  const files = await readMigrationFiles(dir);
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(CREATE_SCHEMA_MIGRATIONS);
    const result = await client.query("select version, checksum from schema_migrations");
    const applied = appliedRowsSchema.parse(result.rows);

    const plan = planMigrations(files, applied);
    if (!plan.ok) {
      throw new Error(`Refusing to migrate:\n${plan.problems.map((p) => `  - ${p}`).join("\n")}`);
    }

    for (const migration of plan.pending) {
      await applyMigration(client, migration);
      logger.info({ version: migration.version }, "applied migration");
    }
    return { applied: plan.pending.map((m) => m.version), alreadyApplied: applied.length };
  } finally {
    // If the connection itself broke, the server already released the lock with the session.
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

async function applyMigration(client: pg.PoolClient, migration: MigrationFile): Promise<void> {
  // Postgres DDL is transactional, so a failing file leaves no half-applied schema behind.
  await client.query("begin");
  try {
    await client.query(migration.sql);
    await client.query("insert into schema_migrations (version, checksum) values ($1, $2)", [
      migration.version,
      migration.checksum,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
