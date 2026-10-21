import { relative } from "node:path";
import { z } from "zod";
import { createPool } from "../db/pool.js";
import { runBackfill } from "../migrate/backfill.js";
import {
  allCodes,
  backfillMarkdown,
  renderCodes,
  renderStatsTable,
  writeRunReports,
} from "../migrate/report.js";
import { ROME_TIME_ZONE } from "../normalize/context.js";
import { COLLECTIONS } from "../source/collections.js";
import { openSourceReader } from "../source/open-reader.js";
import { parseCliArgs, sourceSchema } from "./parse-args.js";
import { runCli } from "./run-cli.js";

const argsSchema = z.object({
  source: sourceSchema,
  "batch-size": z.coerce.number().int().min(1).max(5000).default(500),
  "dry-run": z.boolean().default(false),
  resume: z.boolean().default(false),
  only: z.enum(COLLECTIONS).optional(),
  "json-path": z.string().min(1).optional(),
});

await runCli("backfill", async ({ config, logger }) => {
  const args = parseCliArgs(
    process.argv.slice(2),
    {
      source: { type: "string" },
      "batch-size": { type: "string" },
      "dry-run": { type: "boolean" },
      resume: { type: "boolean" },
      only: { type: "string" },
      "json-path": { type: "string" },
    },
    argsSchema,
  );

  const reader = await openSourceReader(args.source, config, args["json-path"]);
  const pool = createPool(config.db.url, logger);
  try {
    const result = await runBackfill(pool, {
      reader,
      batchSize: args["batch-size"],
      dryRun: args["dry-run"],
      resume: args.resume,
      only: args.only,
      timeZone: ROME_TIME_ZONE,
      logger,
    });
    const meta = {
      runId: result.runId,
      source: reader.name,
      dryRun: result.dryRun,
      resumed: result.resumed,
    };
    const paths = await writeRunReports(
      "run",
      result.runId,
      backfillMarkdown(meta, result.stats, result.rejects),
      {
        ...meta,
        stats: result.stats,
        rejects: result.rejects,
      },
    );

    console.log(`\nBackfill ${result.runId}${result.dryRun ? " (dry run, rolled back)" : ""}\n`);
    console.log(renderStatsTable(result.stats));
    console.log(`\n${renderCodes("Rejected by code", allCodes(result.stats, "rejected"))}`);
    console.log(`\n${renderCodes("Warnings by code", allCodes(result.stats, "warnings"))}`);
    console.log(`\nReport: ${relative(process.cwd(), paths.markdownPath)}\n`);
  } finally {
    await reader.close();
    await pool.end();
  }
});
