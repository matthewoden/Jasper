import { defineConfig, devices } from "@playwright/test";

import base, { WSL_SPEC } from "./playwright.config";

// 6684 is also Jasper's MCP listener port, so a locally running Jasper with MCP
// enabled collides — override JASPER_WSL_HOST_PORT here and in the compose file
// together if that happens.
const HOST_PORT = process.env.JASPER_WSL_HOST_PORT ?? "6684";

// A separate config rather than a second `projects[]` entry: Playwright runs
// every configured project unless --project is passed, so a project would turn
// the default run's 3 skips into 3 failures whenever the container is down.
export default defineConfig({
  ...base,
  testIgnore: ["**/node_modules/**"],
  testMatch: WSL_SPEC,
  // The container is a single fixed listener; parallel workers would race one
  // backend and one vault.
  fullyParallel: false,
  workers: 1,
  use: {
    ...base.use,
    baseURL: `http://127.0.0.1:${HOST_PORT}`,
  },
  projects: [{ name: "wsl", use: { ...devices["Desktop Chrome"] } }],
});
