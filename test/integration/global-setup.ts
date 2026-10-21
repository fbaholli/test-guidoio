import pg from "pg";
import { MIGRATIONS_DIR, runMigrations } from "../../src/db/migrate.js";
import { createLogger } from "../../src/logger.js";
import {
  TEMPLATE_DATABASE,
  testDatabaseUrl,
  withAdminClient,
  withDatabase,
} from "../support/test-database.js";

/** Runs once per `vitest` run: clears leftovers from crashed runs and migrates the template. */
export async function setup(): Promise<void> {
  await withAdminClient(async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      "select datname from pg_database where datname like 'ds\\_test\\_%'",
    );
    for (const { datname } of rows) {
      await client.query(`drop database if exists ${datname} with (force)`);
    }
    await client.query(`create database ${TEMPLATE_DATABASE}`);
  });

  // The pool must be closed before tests start: Postgres refuses to copy a database that
  // has open connections.
  const pool = new pg.Pool({
    connectionString: withDatabase(testDatabaseUrl(), TEMPLATE_DATABASE),
  });
  try {
    await runMigrations(pool, MIGRATIONS_DIR, createLogger("silent"));
  } finally {
    await pool.end();
  }
}
