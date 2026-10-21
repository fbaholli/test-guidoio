import { parseArgs } from "node:util";
import { z } from "zod";

const seedArgsSchema = z.object({
  target: z.enum(["emulator", "json", "firestore"]).default("emulator"),
  out: z.string().min(1).optional(),
});

export type SeedArgs = z.infer<typeof seedArgsSchema>;

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  // `pnpm seed -- --target=json` passes the `--` through; it means nothing here.
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const { values } = parseArgs({
    args,
    options: { target: { type: "string" }, out: { type: "string" } },
    strict: true,
  });
  const result = seedArgsSchema.safeParse(values);
  if (!result.success) throw new Error(`Invalid arguments:\n${z.prettifyError(result.error)}`);
  return result.data;
}
