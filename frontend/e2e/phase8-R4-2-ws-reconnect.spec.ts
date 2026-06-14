/**
 * Cloud-icon click forces immediate WS reconnect.
 *
 * Pre-fix: after a server restart the SPA WS sat in jittered-exponential
 * backoff (up to ~45s/attempt). Clicking the cloud-off SaveIndicator fired
 * a doomed postAdminReindex against the dead server. Only a full page refresh
 * recovered connectivity.
 *
 * Post-fix:
 *   - useSessionSync publishes forceReconnect() on useTreeStore
 *   - StatusBar's handleRefresh routes saveState.status === "paused"
 *     to forceWsReconnect() instead of postAdminReindex
 *
 * This spec drives the full path:
 *   1. SPA connects, ConnectionStatusDot reads "connected"
 *   2. Kill the server → dot transitions to "reconnecting" + SaveIndicator
 *      flips to "paused"
 *   3. Respawn the server on the SAME port (so the WS URL still resolves)
 *   4. Click the SaveIndicator while in backoff
 *   5. ConnectionStatusDot returns to "connected" within a couple seconds
 *      — NOT the 30+s of natural backoff
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const JASPER_BIN = path.join(repoRoot, "bin", "jasper");

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        reject(new Error("could not allocate free port"));
      }
    });
  });
}

async function waitForVaultEndpoint(baseURL: string, deadlineMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await fetch(`${baseURL}/api/v1/vault/current`);
      if (r.ok || r.status === 404) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`jasper not ready at ${baseURL} within ${deadlineMs}ms`);
}

interface VaultHandle {
  proc: ChildProcess;
  baseURL: string;
  port: number;
  kill: () => void;
}

/**
 * Spawn on a pre-chosen port so a respawn can rebind the same port
 * (and the SPA's already-loaded WS URL still resolves).
 */
async function spawnJasperOnPort(
  appHome: string,
  port: number,
): Promise<VaultHandle> {
  if (!fs.existsSync(JASPER_BIN)) {
    throw new Error(`bin/jasper missing — run \`make build\` first. Expected: ${JASPER_BIN}`);
  }
  const proc = spawn(JASPER_BIN, ["serve", "--addr", `127.0.0.1:${port}`], {
    env: { ...process.env, JASPER_APP_HOME: appHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (b) => process.stderr.write(`[jasper:${port}] ${b}`));
  proc.stderr?.on("data", (b) => process.stderr.write(`[jasper:${port}] ${b}`));
  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitForVaultEndpoint(baseURL, 15_000);
  } catch (e) {
    proc.kill("SIGTERM");
    throw e;
  }
  return { proc, baseURL, port, kill: () => { proc.kill("SIGTERM"); } };
}

async function bootstrapVault(baseURL: string, vaultDir: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/v1/vault/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: vaultDir, theme: "dark", daily_template: "", mcp_enabled: false,
    }),
  });
  if (!res.ok) throw new Error(`vault/create failed: ${res.status} ${await res.text()}`);
}

async function openVault(baseURL: string, vaultPath: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/v1/vault/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: vaultPath }),
  });
  if (!res.ok) throw new Error(`vault/open failed: ${res.status} ${await res.text()}`);
}

function canonVaultPath(p: string): string {
  const real = fs.realpathSync(p);
  return process.platform === "darwin" ? real.toLowerCase() : real;
}

/**
 * Wait until SIGTERM'd child actually exits — important so the new
 * spawn can rebind the port without EADDRINUSE.
 */
async function waitForExit(proc: ChildProcess, deadlineMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return;
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (proc.exitCode !== null) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("jasper process did not exit after SIGTERM");
}

test.describe("Phase 8 R4-2 — WS forceReconnect on cloud-icon click", () => {
  test("after server kill + restart, clicking the SaveIndicator restores WS without a page refresh", async ({
    page,
  }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-2-app-"));
    const vault = canonVaultPath(
      fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-2-vault-")),
    );
    const port = await findFreePort();

    let handle: VaultHandle | undefined;
    try {
      handle = await spawnJasperOnPort(appHome, port);
      await bootstrapVault(handle.baseURL, vault);
      await openVault(handle.baseURL, vault);

      await page.goto(handle.baseURL + "/");
      await expect(page.getByTestId("status-bar")).toBeVisible({ timeout: 10_000 });

      const dot = page.getByTestId("connection-status-dot");
      await expect(dot).toHaveAttribute("data-status", "connected", {
        timeout: 5_000,
      });

      const proc = handle.proc;
      handle.kill();
      await waitForExit(proc, 5_000);

      await expect(dot).toHaveAttribute("data-status", "reconnecting", {
        timeout: 5_000,
      });
      const saveBtn = page.locator('[data-save-state="paused"]');
      await expect(saveBtn).toBeVisible({ timeout: 5_000 });

      await new Promise((r) => setTimeout(r, 500));
      handle = await spawnJasperOnPort(appHome, port);

      await saveBtn.click();

      await expect(dot).toHaveAttribute("data-status", "connected", {
        timeout: 8_000,
      });
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});
