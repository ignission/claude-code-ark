import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/server/src/**/*.test.ts",
      "packages/shared/src/**/*.test.ts",
      "packages/web/src/**/*.test.{ts,tsx}",
    ],
    environment: "node",
  },
});
