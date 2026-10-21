import type pg from "pg";

// The Postgres server is shared with other projects, so only databases this project owns
// may be wiped: the dev database and the throwaway test databases.
const RESETTABLE_DATABASE = /^(driving_school|ds_test_)/;

/** Returns why a reset must be refused, or undefined when it is allowed. */
export function resetRefusal(databaseUrl: string, nodeEnv: string): string | undefined {
  if (nodeEnv === "production") {
    return "refusing to reset a database while NODE_ENV=production";
  }
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!RESETTABLE_DATABASE.test(databaseName)) {
    return `refusing to reset database "${databaseName}": only driving_school* and ds_test_* may be reset`;
  }
  return undefined;
}

export async function dropAllObjects(pool: pg.Pool): Promise<void> {
  // Dropping the schema also drops schema_migrations and the extensions, so the next
  // migrate starts from zero.
  await pool.query("drop schema public cascade; create schema public;");
}
