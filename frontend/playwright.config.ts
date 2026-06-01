import { defineConfig, devices } from "@playwright/test";
import { execSync } from "node:child_process";

// Phase 8 D-40: default baseURL reads from scripts/port.sh so any spec
// that does NOT spawn its own binary via e2e/helpers/binary.ts (which
// allocates an ephemeral port) inherits the canonical server.port.
// Most existing specs DO use spawnJasper() and override `page.goto`
// with the ephemeral baseURL — this default just keeps stragglers in
// parity with prod.
let PORT = "6683";
try {
  PORT = execSync("../scripts/port.sh", { encoding: "utf8" }).trim() || "6683";
} catch {
  PORT = "6683";
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // Exclude stale Claude-agent worktrees that contain duplicate spec
  // files. Without this, Playwright walks into the worktree mirrors
  // and double-loads test.beforeEach / test.describe causing "Test
  // did not expect ... to be called here" errors.
  testIgnore: ["**/.claude/**", "**/node_modules/**"],
  // Each test gets a fresh data dir + ephemeral port via beforeEach.
  fullyParallel: false, // we manage one binary per test serially
  workers: 1,
  retries: 0, // E2E flakes mean a real bug — retry hides
  forbidOnly: true,
  reporter: [["list"]],
  expect: { timeout: 10_000 }, // generous: real binary boot + UI render
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
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
