/**
 * Phase 8 vault picker E2E spec — Plan 08-17c Task 4.
 *
 * Per CLAUDE.md §"Verification policy: E2E before human UAT":
 * This spec MUST run against bin/jasper (from `make build`) BEFORE human UAT.
 *
 * Scenarios:
 *   1. no-vault boot shows picker with create+open tabs (default tab = create)
 *      and 08-16 polish copy verbatim
 *   2. create new vault → app.json registers entry → SPA reloads to main shell
 *      with vault display_name visible in StatusBar
 *   3. path validation refuses non-ASCII paths inline (V-PARK-1)
 *   4. missing-folder recent entry renders V11 affordances (Folder not found +
 *      Reconnect + Remove)
 *
 * Binary: spawned from bin/jasper (CLAUDE.md §Build & embed pipeline — bin/jasper
 * must exist; run `make build` first). Each test uses a fresh JASPER_APP_HOME
 * so vault state is isolated.
 *
 * JASPER_APP_HOME: the vault model stores app.json (current_vault + recent_vaults)
 * in this directory. Each test creates an ephemeral one and passes it via the
 * JASPER_APP_HOME env var. The binary infers the vault model from the absence of
 * a pre-existing vault in app.json (boot without a vault → GET /vault/current null
 * → VaultPicker mode="boot" renders).
 *
 * Note: this spec does NOT use the existing spawnJasper helper from
 * e2e/helpers/binary.ts (which uses --data-dir) because the vault model
 * uses JASPER_APP_HOME. Tests spawn the binary directly following the same
 * pattern but with the vault-model env var.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
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
      if (r.ok || r.status === 404) return; // either response = server is up
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`jasper did not become ready at ${baseURL} within ${deadlineMs}ms`);
}

interface VaultHandle {
  proc: ChildProcess;
  baseURL: string;
  appHome: string;
  kill: () => void;
}

async function spawnVaultJasper(appHome: string): Promise<VaultHandle> {
  // Fail-fast guard
  if (!fs.existsSync(JASPER_BIN)) {
    throw new Error(
      `bin/jasper missing — run \`make build\` first (CLAUDE.md §Build & embed pipeline). ` +
      `Expected at: ${JASPER_BIN}`,
    );
  }
  const port = await findFreePort();
  const proc = spawn(
    JASPER_BIN,
    ["serve", "--addr", `127.0.0.1:${port}`],
    {
      env: { ...process.env, JASPER_APP_HOME: appHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout?.on("data", (b) => process.stderr.write(`[jasper] ${b}`));
  proc.stderr?.on("data", (b) => process.stderr.write(`[jasper] ${b}`));

  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitForVaultEndpoint(baseURL, 15_000);
  } catch (e) {
    proc.kill("SIGTERM");
    throw e;
  }
  return {
    proc,
    baseURL,
    appHome,
    kill: () => {
      proc.kill("SIGTERM");
    },
  };
}

test.describe("Phase 8 vault picker — make-build smoke (Plan 08-17c)", () => {
  test("no-vault boot shows the picker with create+open tabs (default = create)", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-vault-e2e-app-"));
    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      // The picker dialog should be visible
      await expect(page.getByRole("dialog", { name: /vault/i })).toBeVisible();

      // Both tab labels should be visible
      await expect(page.getByRole("tab", { name: /open existing/i })).toBeVisible();
      await expect(page.getByRole("tab", { name: /create new/i })).toBeVisible();

      // No recents on first boot → default tab is "create new"
      await expect(page.getByRole("tab", { name: /create new/i })).toHaveAttribute("aria-selected", "true");

      // 08-16 polish verbatim (MCP section needs to be enabled to show tier copy)
      await page.getByRole("checkbox", { name: /enable mcp/i }).click();
      await expect(page.getByText("Edit only (create + update)")).toBeVisible();
      await expect(page.getByText("Full (create + update + move + delete)")).toBeVisible();
      await expect(page.getByText("REQUIRED")).toBeVisible();
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
    }
  });

  test("create new vault → StatusBar shows vault display_name after reload", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-vault-e2e-app-"));
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-vault-e2e-vault-"));
    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      // Fill in the vault path
      await page.getByTestId("vault-create-path-input").fill(vaultDir);

      // Submit (daily template and other defaults are acceptable for smoke)
      await page.getByRole("button", { name: /create vault/i }).click();

      // SPA reloads after create — wait for the page to settle
      await page.waitForURL(handle.baseURL + "/");

      // After reload, the main shell mounts — StatusBar shows the vault name
      await expect(page.getByTestId("status-bar-vault")).toBeVisible({ timeout: 10_000 });

      // The display name should match the folder base name (or a slug of it)
      const displayName = await page.getByTestId("status-bar-vault").textContent();
      expect(displayName?.toLowerCase()).toContain(path.basename(vaultDir).toLowerCase().substring(0, 10));

      // app.json on disk has the entry
      const appJSONPath = path.join(appHome, "app.json");
      expect(fs.existsSync(appJSONPath)).toBe(true);
      const appJSON = JSON.parse(fs.readFileSync(appJSONPath, "utf8")) as {
        current_vault?: string;
        recent_vaults?: unknown[];
      };
      expect(appJSON.recent_vaults).toHaveLength(1);
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  test("path validation refuses non-ASCII paths inline (V-PARK-1)", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-vault-e2e-app-"));
    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      // Type a path with a non-ASCII character
      await page.getByTestId("vault-create-path-input").fill("/tmp/café-vault");

      // Inline validation error should appear
      await expect(page.getByText(/Path must be ASCII/i)).toBeVisible();

      // Submit button should be disabled
      await expect(page.getByRole("button", { name: /create vault/i })).toBeDisabled();
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
    }
  });

  test("missing-folder recent entry renders V11 affordances (Folder not found + Reconnect + Remove)", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-vault-e2e-app-"));
    const missingPath = path.join(os.tmpdir(), "never-existed-jasper-vault-e2e");

    // Pre-populate app.json with a "missing" vault entry
    // Server will probe the path on Load and mark it missing
    const appJSON = {
      current_vault: "",
      recent_vaults: [
        {
          path: missingPath,
          display_name: "Old Vault",
          last_opened_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          missing: false, // server probes on boot and sets to true
        },
      ],
    };
    fs.writeFileSync(path.join(appHome, "app.json"), JSON.stringify(appJSON));

    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      // Navigate to the Recent tab
      await page.getByRole("tab", { name: /recent/i }).click();

      // The V11 "Folder not found" caption should be visible
      await expect(page.getByText("Folder not found")).toBeVisible();

      // Reconnect and Remove buttons
      await expect(page.getByRole("button", { name: /reconnect/i })).toBeVisible();
      await expect(page.getByRole("button", { name: /remove/i })).toBeVisible();
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
    }
  });
});
