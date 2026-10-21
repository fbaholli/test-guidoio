import { type ParseArgsConfig, parseArgs } from "node:util";
import { z } from "zod";

/** Strict flag parsing, then zod for types and defaults. Unknown flags are errors. */
export function parseCliArgs<S extends z.ZodType>(
  argv: readonly string[],
  options: NonNullable<ParseArgsConfig["options"]>,
  schema: S,
): z.output<S> {
  // `pnpm x -- --flag` passes the `--` through; it means nothing here.
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const { values } = parseArgs({ args, options, strict: true });
  const result = schema.safeParse(values);
  if (!result.success) throw new Error(`Invalid arguments:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export const sourceSchema = z.enum(["emulator", "firestore", "json"]).default("emulator");
