import { z } from "zod";

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/, error: "must be a postgres:// URL" });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: postgresUrl,
  TEST_DATABASE_URL: postgresUrl.optional(),
  FIREBASE_PROJECT_ID: z.string().min(1).default("demo-driving-school"),
  FIRESTORE_EMULATOR_HOST: z.string().min(1).optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  BOOKINGS_READ_SOURCE: z.enum(["firestore", "postgres", "shadow"]).default("firestore"),
});

type Env = z.output<typeof envSchema>;

export type Config = {
  nodeEnv: Env["NODE_ENV"];
  logLevel: Env["LOG_LEVEL"];
  db: { url: string; testUrl: string | undefined };
  firestore: {
    projectId: string;
    emulatorHost: string | undefined;
    credentialsPath: string | undefined;
  };
  api: { host: string; port: number; bookingsReadSource: Env["BOOKINGS_READ_SOURCE"] };
};

/** Issues name the variable, never its value: DATABASE_URL carries a password. */
export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(withoutBlankValues(env));
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  const parsed = result.data;
  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    db: { url: parsed.DATABASE_URL, testUrl: parsed.TEST_DATABASE_URL },
    firestore: {
      projectId: parsed.FIREBASE_PROJECT_ID,
      emulatorHost: parsed.FIRESTORE_EMULATOR_HOST,
      credentialsPath: parsed.GOOGLE_APPLICATION_CREDENTIALS,
    },
    api: {
      host: parsed.HOST,
      port: parsed.PORT,
      bookingsReadSource: parsed.BOOKINGS_READ_SOURCE,
    },
  };
}

// A line like `FIRESTORE_EMULATOR_HOST=` in .env means "not set", not "set to an invalid value".
function withoutBlankValues(env: Record<string, string | undefined>): Record<string, string> {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim() !== "",
  );
  return Object.fromEntries(entries);
}
