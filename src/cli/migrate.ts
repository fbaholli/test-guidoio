import { MIGRATIONS_DIR, runMigrations } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { runCli } from "./run-cli.js";

await runCli("db:migrate", async ({ config, logger }) => {
  const pool = createPool(config.db.url, logger);
  try {
    const { applied, alreadyApplied } = await runMigrations(pool, MIGRATIONS_DIR, logger);
    const message = applied.length > 0 ? "migrations applied" : "database already up to date";
    logger.info({ applied: applied.length, alreadyApplied }, message);
  } finally {
    await pool.end();
  }
});
