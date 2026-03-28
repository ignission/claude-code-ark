import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2Eテスト設定
 *
 * サーバーはpm2で既に稼働しているため、webServer設定は不要。
 * localhost:3001 に対してテストを実行する。
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  timeout: 30_000,

  use: {
    baseURL: "http://localhost:3001",
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
