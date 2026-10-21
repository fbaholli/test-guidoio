import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Integration tests read TEST_DATABASE_URL. Locally it lives in .env; CI sets it directly.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          globalSetup: ["test/integration/global-setup.ts"],
          // The database may be on another machine over the LAN, so allow for slow round trips.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
