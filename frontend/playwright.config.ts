import { defineConfig, devices } from "@playwright/test";
import { execSync } from "node:child_process";


let PORT = "6683";
try {
  PORT = execSync("../scripts/port.sh", { encoding: "utf8" }).trim() || "6683";
} catch {
  PORT = "6683";
}

// Owned by playwright.wsl.config.ts — it needs compose/wsl-validation up, so it
// is excluded from the default run rather than reporting as skipped, where it
// would be indistinguishable from a test.fixme'd gap.
export const WSL_SPEC = "**/phase8-wsl-vault.spec.ts";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  testIgnore: ["**/node_modules/**", WSL_SPEC],
  // Fails the run if any spec wrote to the developer's real ~/.jasper/app.json.
  globalSetup: "./e2e/helpers/appHomeGuard.ts",
  globalTeardown: "./e2e/helpers/appHomeGuardTeardown.ts",
  // Each test self-isolates via per-test ephemeral port + mkdtemp data dir.
  // MCP port 6684 is serialized across worker processes via withMcpPortLock
  // in helpers/binary.ts — not via worker-count reduction.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
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
  outputDir: "./e2e/.artifacts",
});
