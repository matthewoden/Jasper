import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // Each test gets a fresh data dir + ephemeral port via beforeEach.
  fullyParallel: false, // we manage one binary per test serially
  workers: 1,
  retries: 0, // E2E flakes mean a real bug — retry hides
  forbidOnly: true,
  reporter: [["list"]],
  expect: { timeout: 10_000 }, // generous: real binary boot + UI render
  use: {
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Per-test webServer is OFF — we spawn the binary in test setup so we
  // can control the data-dir + port per test (each test wants a fresh
  // vault).
  outputDir: "./e2e/.artifacts",
});
