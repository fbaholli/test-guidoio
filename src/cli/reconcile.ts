import { relative } from "node:path";
import { z } from "zod";
import { createPool } from "../db/pool.js";
import { reconcile } from "../migrate/reconcile.js";
import { reconcileMarkdown, renderReconcileSummary } from "../migrate/reconcile-report.js";
import { writeRunReports } from "../migrate/report.js";
import { ROME_TIME_ZONE } from "../normalize/context.js";
import { openSourceReader } from "../source/open-reader.js";
import { parseCliArgs, sourceSchema } from "./parse-args.js";
import { runCli } from "./run-cli.js";

const argsSchema = z.object({ source: sourceSchema, "json-path": z.string().min(1).optional() });

await runCli("reconcile", async ({ config, logger }) => {
  const args = parseCliArgs(
    process.argv.slice(2),
    { source: { type: "string" }, "json-path": { type: "string" } },
    argsSchema,
  );
  const reader = await openSourceReader(args.source, config, args["json-path"]);
  const pool = createPool(config.db.url, logger);
  try {
    const result = await reconcile(pool, reader, ROME_TIME_ZONE);
    const paths = await writeRunReports(
      "reconcile",
      result.runId,
      reconcileMarkdown(result, reader.name),
      result,
    );
    console.log(`\nReconciliation ${result.runId} (source: ${reader.name})\n`);
    console.log(renderReconcileSummary(result));
    console.log(`\nReport: ${relative(process.cwd(), paths.markdownPath)}\n`);
    // The cutover gate: anything but a clean result fails the command.
    if (!result.clean) process.exitCode = 1;
  } finally {
    await reader.close();
    await pool.end();
  }
});
