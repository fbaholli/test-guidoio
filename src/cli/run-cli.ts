import type { Logger } from "pino";
import { type Config, ConfigError, loadConfig } from "../config.js";
import { createLogger } from "../logger.js";

export type CliContext = { config: Config; logger: Logger };

/** Shared CLI wrapper: loads config, creates the logger and turns failures into exit code 1. */
export async function runCli(name: string, main: (context: CliContext) => Promise<void>) {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`${name}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logLevel);
  try {
    await main({ config, logger });
  } catch (error) {
    logger.error({ err: error }, `${name} failed`);
    process.exitCode = 1;
  }
}
