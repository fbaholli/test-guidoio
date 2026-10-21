import { MIGRATIONS_DIR, runMigrations } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { dropAllObjects, resetRefusal } from "../db/reset.js";
import { runCli } from "./run-cli.js";

await runCli("db:reset", async ({ config, logger }) => {
  const refusal = resetRefusal(config.db.url, config.nodeEnv);
  if (refusal) throw new Error(refusal);

  const pool = createPool(config.db.url, logger);
  try {
    await dropAllObjects(pool);
    logger.info("dropped everything in schema public");
    const { applied } = await runMigrations(pool, MIGRATIONS_DIR, logger);
    logger.info({ applied: applied.length }, "database reset");
  } finally {
    await pool.end();
  }
});
