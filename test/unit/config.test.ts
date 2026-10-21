import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

const PASSWORD = "s3cret-pw";
const minimalEnv = {
  DATABASE_URL: `postgres://driving:${PASSWORD}@localhost:54329/driving_school`,
};

function configErrorFor(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("fills in defaults when only DATABASE_URL is set", () => {
    expect(loadConfig(minimalEnv)).toEqual({
      nodeEnv: "development",
      logLevel: "info",
      db: { url: minimalEnv.DATABASE_URL, testUrl: undefined },
      firestore: {
        projectId: "demo-driving-school",
        emulatorHost: undefined,
        credentialsPath: undefined,
      },
      api: { host: "127.0.0.1", port: 3000, bookingsReadSource: "firestore" },
    });
  });

  it("reads every variable it knows", () => {
    const config = loadConfig({
      ...minimalEnv,
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      TEST_DATABASE_URL: "postgresql://driving:pw@db:5432/postgres",
      FIREBASE_PROJECT_ID: "demo-other",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      GOOGLE_APPLICATION_CREDENTIALS: "/secrets/sa.json",
      HOST: "0.0.0.0",
      PORT: "8081",
      BOOKINGS_READ_SOURCE: "shadow",
    });

    expect(config.nodeEnv).toBe("test");
    expect(config.logLevel).toBe("silent");
    expect(config.db.testUrl).toBe("postgresql://driving:pw@db:5432/postgres");
    expect(config.firestore).toEqual({
      projectId: "demo-other",
      emulatorHost: "127.0.0.1:8080",
      credentialsPath: "/secrets/sa.json",
    });
    expect(config.api).toEqual({ host: "0.0.0.0", port: 8081, bookingsReadSource: "shadow" });
  });

  it("treats blank values as unset", () => {
    const config = loadConfig({ ...minimalEnv, FIRESTORE_EMULATOR_HOST: "", PORT: "  " });
    expect(config.firestore.emulatorHost).toBeUndefined();
    expect(config.api.port).toBe(3000);
  });

  it.each([
    ["DATABASE_URL is missing", {}, "DATABASE_URL"],
    ["DATABASE_URL is not Postgres", { DATABASE_URL: "mysql://u:p@localhost/db" }, "DATABASE_URL"],
    [
      "TEST_DATABASE_URL is not Postgres",
      { ...minimalEnv, TEST_DATABASE_URL: "http://x" },
      "TEST_DATABASE_URL",
    ],
    [
      "the read source is unknown",
      { ...minimalEnv, BOOKINGS_READ_SOURCE: "mongo" },
      "BOOKINGS_READ_SOURCE",
    ],
    ["PORT is out of range", { ...minimalEnv, PORT: "70000" }, "PORT"],
    ["PORT is not a number", { ...minimalEnv, PORT: "http" }, "PORT"],
    ["LOG_LEVEL is unknown", { ...minimalEnv, LOG_LEVEL: "loud" }, "LOG_LEVEL"],
  ])("rejects the config when %s", (_case, env, variable) => {
    const error = configErrorFor(env);
    expect(error.issues.some((issue) => issue.startsWith(`${variable}:`))).toBe(true);
  });

  it("never puts a variable's value in the error", () => {
    const error = configErrorFor({ DATABASE_URL: `mysql://driving:${PASSWORD}@localhost/db` });
    expect(error.message).not.toContain(PASSWORD);
  });
});
