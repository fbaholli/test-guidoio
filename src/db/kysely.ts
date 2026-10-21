import { Kysely, PostgresDialect } from "kysely";
import type pg from "pg";
import type { DB } from "./types.js";

/** Typed queries over an existing pool. Destroying the Kysely instance also ends the pool. */
export function createDb(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
