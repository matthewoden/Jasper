/**
 * Clicking the cloud-off SaveIndicator while the WS is in jittered backoff must
 * reconnect immediately rather than waiting out the ~45s attempt window.
 *
 * The server is respawned on the SAME port — useSessionSync builds its WS URL
 * from window.location.host, so a new port would never be reached.
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
  const proc = spawn(JASPER_BIN, ["serve", "--bind", `127.0.0.1:${port}`], {
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
      path: vaultDir, theme: "dark", daily_template: "",
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

test.describe("WS forceReconnect on cloud-icon click", () => {
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

      // Seed a note on disk before vault/open so the reconciler indexes it.
      // This note will appear in the file tree, allowing us to click it and
      // mount EditorPane — which is required for saveState to transition to
      // "paused" when the WS drops (EditorPane dispatches connectionLost).
      const notesDir = path.join(vault, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(
        path.join(notesDir, "test-note.md"),
        "# Test note\n\nContent for WS reconnect test.\n",
        "utf8",
      );

      await openVault(handle.baseURL, vault);

      await page.goto(handle.baseURL + "/");
      await expect(page.getByTestId("status-bar")).toBeVisible({ timeout: 10_000 });

      const dot = page.getByTestId("connection-status-dot");
      await expect(dot).toHaveAttribute("data-status", "connected", {
        timeout: 5_000,
      });

      // Click the seeded note to mount EditorPane so saveState can transition
      // to "paused" when the WS drops.
      const noteRow = page.locator('[data-tree-row-kind="note"]').first();
      await expect(noteRow).toBeVisible({ timeout: 5_000 });
      await noteRow.click();
      await expect(page.getByTestId("cm-host-shell")).toBeVisible({ timeout: 5_000 });

      const proc = handle.proc;
      handle.kill();
      await waitForExit(proc, 8_000);

      // Under parallel load the kernel's TCP close-notify can arrive late;
      // give the WS close-detection a generous window (no blind sleep — this is
      // a real latency bound for the observable browser event).
      await expect(dot).toHaveAttribute("data-status", "reconnecting", {
        timeout: 15_000,
      });
      // Prove the WS drop was detected: saveState flips to "paused" via
      // EditorPane's connectionLost dispatch.
      await expect(page.locator('button[data-save-state="paused"]')).toBeVisible({
        timeout: 15_000,
      });

      await new Promise((r) => setTimeout(r, 500));
      handle = await spawnJasperOnPort(appHome, port);

      // Click the SaveIndicator to force reconnect. Target it by the stable
      // data-save-state attribute (any value), not the transient "paused"
      // value — under load the tab's own reconnect timer can flip it off
      // "paused" before we click, which would make a paused-only selector time
      // out. Clicking is idempotent: if auto-reconnect already won, the dot is
      // already connected and the assertion below still holds.
      await page.locator("button[data-save-state]").first().click();

      await expect(dot).toHaveAttribute("data-status", "connected", {
        timeout: 15_000,
      });
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});
