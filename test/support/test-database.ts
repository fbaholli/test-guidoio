import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";
import { createDb } from "../../src/db/kysely.js";
import type { DB } from "../../src/db/types.js";

// Every integration test file gets its own throwaway database, copied from a template that
// global-setup.ts migrated once. Copying is fast, and files can't see each other's data.

export const TEMPLATE_DATABASE = "ds_test_template";

export type TestDatabase = {
  name: string;
  url: string;
  pool: pg.Pool;
  db: Kysely<DB>;
  drop: () => Promise<void>;
};

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set: integration tests need a Postgres to run on");
  }
  return url;
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export async function withAdminClient<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** A fresh database: a copy of the migrated template, or completely empty. */
export async function createTestDatabase(options: { empty?: boolean } = {}): Promise<TestDatabase> {
  const name = `ds_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const template = options.empty ? "template0" : TEMPLATE_DATABASE;
  await withAdminClient((client) => createDatabaseWithRetry(client, name, template));

  const url = withDatabase(testDatabaseUrl(), name);
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const db = createDb(pool);
  return {
    name,
    url,
    pool,
    db,
    drop: async () => {
      await db.destroy();
      // Not WITH (FORCE): the pool's connections may still be closing, and killing them makes
      // pg raise an unhandled error that carries the whole client, password included.
      await withAdminClient((client) =>
        retry(() => client.query(`drop database if exists ${name}`)),
      );
    },
  };
}

// Two files copying the template at the same moment can briefly collide; a retry clears it.
function createDatabaseWithRetry(client: pg.Client, name: string, template: string) {
  return retry(() => client.query(`create database ${name} template ${template}`));
}

async function retry<T>(run: () => Promise<T>, attempts = 10): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}
