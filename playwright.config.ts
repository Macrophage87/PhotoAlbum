import "dotenv/config";
import { defineConfig } from "@playwright/test";

/**
 * End-to-end smoke tests against a production build.
 * Expects DATABASE_URL to point at a disposable database (the tests wipe users/trips/photos).
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3200",
    trace: "retain-on-failure",
    // Set PLAYWRIGHT_CHROMIUM_PATH to reuse a system Chromium instead of downloading one.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : undefined,
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "node scripts/e2e-server.mjs",
        url: "http://localhost:3200/api/health",
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
      },
});
