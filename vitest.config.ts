import { defineConfig } from "vitest/config";

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
          // The database runs on another machine over the LAN, so allow for slow round trips.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
