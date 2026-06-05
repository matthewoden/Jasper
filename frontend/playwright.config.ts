import { defineConfig, devices } from "@playwright/test";
import { execSync } from "node:child_process";


let PORT = "6683";
try {
  PORT = execSync("../scripts/port.sh", { encoding: "utf8" }).trim() || "6683";
} catch {
  PORT = "6683";
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  testIgnore: ["**/.claude/**", "**/node_modules/**"],
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
  outputDir: "./e2e/.artifacts",
});
