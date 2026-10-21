import pg from "pg";
import type { Logger } from "pino";

export function createPool(connectionString: string, logger: Logger): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client can lose its connection (database restart, network blip). Without a
  // listener, pg emits an unhandled 'error' event and the whole process crashes.
  pool.on("error", (err) => logger.error({ err }, "idle Postgres client error"));
  return pool;
}
