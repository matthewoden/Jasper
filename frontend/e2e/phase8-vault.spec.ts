/**
 * Phase 8 vault picker E2E spec.
 *
 * Scenarios:
 *   1. No-vault boot shows picker with create+open tabs (default tab = create)
 *   2. Create new vault → app.json registers entry → SPA reloads to main shell
 *   3. Path validation refuses non-ASCII paths inline
 *   4. Missing-folder recent entry renders V11 affordances (Folder not found +
 *      Reconnect + Remove)
 *
 * Each test uses a fresh JASPER_APP_HOME so vault state is isolated.
 * JASPER_APP_HOME stores app.json (current_vault + recent_vaults). Without a
 * pre-existing vault, GET /vault/current returns null and VaultPicker mounts.
 *
 * Uses a local spawnVaultJasper (not the shared spawnJasper helper) because
 * this spec uses JASPER_APP_HOME, not --data-dir.
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
  kill: () => Promise<void>;
}

async function spawnVaultJasper(appHome: string): Promise<VaultHandle> {
  if (!fs.existsSync(JASPER_BIN)) {
    throw new Error(
      `bin/jasper missing — run \`make build\` first (CLAUDE.md §Build & embed pipeline). ` +
      `Expected at: ${JASPER_BIN}`,
    );
  }
  const port = await findFreePort();
  const proc = spawn(
    JASPER_BIN,
    ["serve", "--bind", `127.0.0.1:${port}`],
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
    // Resolve only after the process actually exits so callers can rmSync the
    // vault/app data dirs without racing the still-running binary (ENOTEMPTY).
    kill: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 3_000);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        proc.kill("SIGTERM");
      }),
  };
}


function canonVaultPath(p: string): string {
  const real = fs.realpathSync(p);
  return process.platform === "darwin" ? real.toLowerCase() : real;
}


async function bootstrapVault(
  baseURL: string,
  vaultDir: string,
): Promise<void> {
  const res = await fetch(`${baseURL}/api/v1/vault/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: vaultDir,
      theme: "dark",
      daily_template: "",
      mcp_enabled: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`vault/create failed for ${vaultDir}: ${res.status} ${body}`);
  }
}

async function openVault(baseURL: string, vaultPath: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/v1/vault/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: vaultPath }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`vault/open failed: ${res.status} ${body}`);
  }
}

/**
 * expectActuallyPainted — asserts a locator is rendered with non-trivial
 * geometry, not just "in the DOM with some bounding box from child text."
 * Playwright's toBeVisible() returns true for an unstyled div whose children
 * give it any non-zero size — so a modal with no CSS still passes.
 *
 * This helper enforces a minimum width/height (defaults: 200×100) so an
 * unstyled element fails the gate. Tune per-call when asserting smaller
 * surfaces (toasts, pills, etc.).
 */
async function expectActuallyPainted(
  loc: import("@playwright/test").Locator,
  opts: { minWidth?: number; minHeight?: number; description?: string } = {},
): Promise<void> {
  const minW = opts.minWidth ?? 200;
  const minH = opts.minHeight ?? 100;
  const label = opts.description ?? "element";
  await expect(loc, `${label}: not in DOM`).toBeAttached();
  await expect(loc, `${label}: not visible per Playwright`).toBeVisible();
  const box = await loc.boundingBox();
  expect(box, `${label}: no bounding box`).not.toBeNull();
  expect(box!.width, `${label}: width ${box!.width}px < ${minW}px (likely unstyled)`).toBeGreaterThanOrEqual(minW);
  expect(box!.height, `${label}: height ${box!.height}px < ${minH}px (likely unstyled)`).toBeGreaterThanOrEqual(minH);
}

test.describe("Phase 8 vault picker — make-build smoke", () => {
  test("no-vault boot shows the picker with create+open tabs (default = create)", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-vault-e2e-app-"));
    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      const picker = page.getByRole("dialog", { name: /vault/i });
      await expectActuallyPainted(picker, {
        minWidth: 400,
        minHeight: 300,
        description: "vault picker modal",
      });

      const viewport = page.viewportSize();
      const minOverlayW = viewport ? Math.floor(viewport.width * 0.9) : 800;
      const minOverlayH = viewport ? Math.floor(viewport.height * 0.9) : 600;
      await expectActuallyPainted(page.locator(".vault-picker-overlay"), {
        minWidth: minOverlayW,
        minHeight: minOverlayH,
        description: "vault picker overlay backdrop",
      });

      await expect(page.getByRole("heading", { name: /choose a vault/i })).toBeVisible();

      await expect(page.getByRole("tab", { name: "Open existing", exact: true })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Create new", exact: true })).toBeVisible();

      await expect(page.getByRole("tab", { name: "Create new", exact: true })).toHaveAttribute("aria-selected", "true");

      await expect(page.getByRole("checkbox", { name: /enable mcp/i })).toHaveCount(0);
      await expect(page.getByText(/edit only \(create \+ update\)/i)).toHaveCount(0);

      await expectActuallyPainted(page.getByTestId("vault-create-path-input"), {
        minWidth: 400,
        minHeight: 28,
        description: "vault path input",
      });

      const ta = page.getByRole("textbox", { name: /daily note template/i });
      await expect(ta).toHaveValue("# {{date}}\n\n");
      await expectActuallyPainted(ta, { minWidth: 400, minHeight: 80, description: "daily template textarea" });

      const submitBtn = page.getByTestId("vault-create-submit");
      await expectActuallyPainted(submitBtn, { minWidth: 100, minHeight: 32, description: "Create vault button" });
      await expect(submitBtn).toHaveText(/create vault/i);
      await expect(submitBtn).toBeDisabled();
      await page.getByTestId("vault-create-path-input").fill("/tmp/jasper-uat-2-1d-smoke");
      await expect(submitBtn).toBeEnabled();

      // Theme live-preview toggle removed in v1.2 (Phase 17 D-01: Jasper is
      // dark-only). applyTheme() now sets data-theme="dark" unconditionally, so
      // the old light/dark radio preview assertions are obsolete. The app stays
      // dark regardless of selection.
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    } finally {
      await handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
    }
  });

  test("folder picker — browse, click into a subfolder, select returns that path", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-fs-pick-app-"));
    const browseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-fs-pick-root-"));
    const targetSub = "uat-picker-target";
    fs.mkdirSync(path.join(browseRoot, targetSub));
    fs.mkdirSync(path.join(browseRoot, "another-sibling"));

    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      await page.getByTestId("vault-create-path-input").fill(browseRoot);
      await page.getByTestId("vault-create-browse").click();

      const folderPicker = page.getByTestId("folder-picker");
      await expectActuallyPainted(folderPicker, {
        minWidth: 400,
        minHeight: 300,
        description: "folder picker modal",
      });

      await expect(page.getByTestId("folder-picker-current-path")).toContainText(
        new RegExp(path.basename(browseRoot)),
      );

      const entries = page.getByTestId("folder-picker-entries");
      await expect(entries.locator("button")).toHaveCount(2);
      await expect(entries.locator("button").first()).toContainText("another-sibling");

      await page.getByTestId(`folder-picker-entry-${targetSub}`).click();
      await expect(page.getByTestId("folder-picker-current-path")).toContainText(targetSub);

      await page.getByTestId("folder-picker-select").click();
      await expect(folderPicker).toHaveCount(0);
      const inputValue = await page.getByTestId("vault-create-path-input").inputValue();
      expect(inputValue).toContain(targetSub);
      expect(path.isAbsolute(inputValue)).toBe(true);
    } finally {
      await handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(browseRoot, { recursive: true, force: true });
    }
  });

  test("folder picker — double-click breadcrumb opens path input; Enter loads typed path", async ({
    page,
  }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "fs-pick-edit-app-"));
    const browseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fs-pick-edit-root-"));
    const jumpTarget = path.join(browseRoot, "jump-target");
    fs.mkdirSync(jumpTarget);
    fs.mkdirSync(path.join(browseRoot, "unrelated-sibling"));

    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      await page.getByTestId("vault-create-path-input").fill(browseRoot);
      await page.getByTestId("vault-create-browse").click();
      await expect(page.getByTestId("folder-picker")).toBeVisible();

      // The picker fetches its listing async; dblclicking the breadcrumb before
      // it settles drops the event and the path-input never opens. Wait for the
      // loaded directory (current-path populated) before interacting.
      await expect(page.getByTestId("folder-picker-current-path")).toContainText(
        path.basename(browseRoot),
      );
      await expect(page.getByTestId("folder-picker-entries")).toBeVisible();

      const crumb = page.getByTestId("folder-picker-breadcrumb");
      await crumb.dblclick();

      const pathInput = page.getByTestId("folder-picker-path-input");
      await expect(pathInput).toBeVisible();
      const prefilled = await pathInput.inputValue();
      expect(path.isAbsolute(prefilled)).toBe(true);

      await pathInput.fill(jumpTarget);
      await pathInput.press("Enter");

      await expect(page.getByTestId("folder-picker-path-input")).toHaveCount(0);
      await expect(page.getByTestId("folder-picker-current-path")).toContainText(
        path.basename(jumpTarget),
      );

      await page.getByTestId("folder-picker-select").click();
      const inputValue = await page.getByTestId("vault-create-path-input").inputValue();
      expect(inputValue).toContain(path.basename(jumpTarget));
    } finally {
      await handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(browseRoot, { recursive: true, force: true });
    }
  });

  test("folder picker — detects existing .jasper/ and swaps footer to Open Vault + Go up", async ({
    page,
  }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-pick-detect-app-"));
    const browseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-pick-detect-root-"));
    const existingVault = path.join(browseRoot, "ExistingVault");
    fs.mkdirSync(existingVault);
    fs.mkdirSync(path.join(existingVault, ".jasper"));
    fs.mkdirSync(path.join(browseRoot, "PlainFolder"));

    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      await page.getByTestId("vault-create-path-input").fill(browseRoot);
      await page.getByTestId("vault-create-browse").click();
      await expect(page.getByTestId("folder-picker")).toBeVisible();

      await expect(page.getByTestId("folder-picker-vault-banner")).toHaveCount(0);
      await expect(page.getByTestId("folder-picker-select")).toBeVisible();

      await page.getByTestId("folder-picker-entry-ExistingVault").click();

      await expect(page.getByTestId("folder-picker-vault-banner")).toContainText(
        /already a Jasper vault/i,
      );
      await expect(page.getByTestId("folder-picker-open-vault")).toBeVisible();
      await expect(page.getByTestId("folder-picker-go-up")).toBeVisible();
      await expect(page.getByTestId("folder-picker-select")).toHaveCount(0);

      await page.getByTestId("folder-picker-go-up").click();
      await expect(page.getByTestId("folder-picker-vault-banner")).toHaveCount(0);
      await expect(page.getByTestId("folder-picker-current-path-primary")).toContainText(
        path.basename(browseRoot),
      );
      await expect(page.getByTestId("folder-picker")).toBeVisible();
    } finally {
      await handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(browseRoot, { recursive: true, force: true });
    }
  });

  test("folder picker — '+ New folder' creates a folder inline and re-lists", async ({
    page,
  }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-pick-mkdir-app-"));
    const browseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-pick-mkdir-root-"));

    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      await page.getByTestId("vault-create-path-input").fill(browseRoot);
      await page.getByTestId("vault-create-browse").click();
      await expect(page.getByTestId("folder-picker")).toBeVisible();

      await page.getByTestId("folder-picker-new-folder-button").click();
      const nameInput = page.getByTestId("folder-picker-new-folder-input");
      await expect(nameInput).toBeVisible();

      const targetName = "Brand New Vault";
      await nameInput.fill(targetName);
      await nameInput.press("Enter");

      await expect(nameInput).toHaveCount(0);
      await expect(
        page.getByTestId(`folder-picker-entry-${targetName}`),
      ).toBeVisible({ timeout: 5_000 });
      expect(fs.existsSync(path.join(browseRoot, targetName))).toBe(true);
    } finally {
      await handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(browseRoot, { recursive: true, force: true });
    }
  });

  test("create new vault → StatusBar shows vault display_name after reload", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-vault-e2e-app-"));
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-vault-e2e-vault-"));
    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      await page.getByTestId("vault-create-path-input").fill(vaultDir);

      await page.getByRole("button", { name: /create vault/i }).click();

      await page.waitForURL(handle.baseURL + "/");

      await expect(page.getByTestId("status-bar-vault")).toBeVisible({ timeout: 10_000 });

      const displayName = await page.getByTestId("status-bar-vault").textContent();
      expect(displayName?.toLowerCase()).toContain(path.basename(vaultDir).toLowerCase().substring(0, 10));

      const appJSONPath = path.join(appHome, "app.json");
      expect(fs.existsSync(appJSONPath)).toBe(true);
      const appJSON = JSON.parse(fs.readFileSync(appJSONPath, "utf8")) as {
        current_vault?: string;
        recent_vaults?: unknown[];
      };
      expect(appJSON.recent_vaults).toHaveLength(1);
    } finally {
      await handle?.kill();
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

      await page.getByTestId("vault-create-path-input").fill("/tmp/café-vault");

      await expect(page.getByText(/Path must be ASCII/i)).toBeVisible();

      await expect(page.getByRole("button", { name: /create vault/i })).toBeDisabled();
    } finally {
      await handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
    }
  });

  test("missing-folder recent entry renders V11 affordances (Folder not found + Reconnect + Remove)", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-vault-e2e-app-"));
    const missingPath = path.join(os.tmpdir(), "never-existed-jasper-vault-e2e");

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

      await page.getByRole("tab", { name: /recent/i }).click();

      await expect(page.getByText("Folder not found")).toBeVisible();

      await expect(page.getByRole("button", { name: /reconnect/i })).toBeVisible();
      await expect(page.getByRole("button", { name: /remove/i })).toBeVisible();
    } finally {
      await handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
    }
  });
});


test.describe("Phase 8 vault switch — make-build smoke", () => {
  /**
   * Switch from vault A to vault B.
   *
   * The VaultSwitchOverlay may appear and disappear quickly (sub-second in
   * test environments). The load-bearing assertion is the final StatusBar state.
   */
  test("switch from vault A to vault B — SPA reloads to new vault, StatusBar shows B", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-app-"));
    const vaultA = canonVaultPath(fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-A-")));
    const vaultB = canonVaultPath(fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-B-")));
    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);

      await bootstrapVault(handle.baseURL, vaultA);
      await bootstrapVault(handle.baseURL, vaultB);
      await openVault(handle.baseURL, vaultA);

      await page.goto(handle.baseURL + "/");
      await expect(page.getByTestId("status-bar-vault")).toBeVisible({ timeout: 10_000 });

      const nameA = path.basename(vaultA);
      await expect(page.getByTestId("status-bar-vault")).toContainText(nameA.substring(0, 8), { timeout: 5_000 });

      await page.getByTestId("status-bar-vault").click();
      await expect(page.getByRole("dialog", { name: /vault/i })).toBeVisible({ timeout: 5_000 });

      await page.getByRole("tab", { name: /recent/i }).click();
      const nameB = path.basename(vaultB);
      await page.getByTestId(`vault-row-${vaultB}`).click({ timeout: 5_000 });

      await page.waitForFunction(
        (name) => {
          const el = document.querySelector('[data-testid="status-bar-vault"]');
          return el !== null && el.textContent !== null && el.textContent.includes(name.substring(0, 8));
        },
        nameB,
        { timeout: 20_000 },
      );
    } finally {
      await handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vaultA, { recursive: true, force: true });
      fs.rmSync(vaultB, { recursive: true, force: true });
    }
  });

  /**
   * Concurrent switch returns 409 with vault_switch_in_progress.
   *
   * Fires two simultaneous POST /vault/switch requests. One must succeed
   * (200) and the other must be rejected (409). Uses the request fixture —
   * pure API test.
   */
  test("concurrent switch returns 409 with vault_switch_in_progress", async ({ request }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-409-app-"));
    const vaultA = canonVaultPath(fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-409-A-")));
    const vaultB1 = canonVaultPath(fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-409-B1-")));
    const vaultB2 = canonVaultPath(fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-409-B2-")));
    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);

      await bootstrapVault(handle.baseURL, vaultA);
      await bootstrapVault(handle.baseURL, vaultB1);
      await bootstrapVault(handle.baseURL, vaultB2);
      await openVault(handle.baseURL, vaultA);

      const [r1, r2] = await Promise.all([
        request.post(`${handle.baseURL}/api/v1/vault/switch`, {
          data: { path: vaultB1 },
        }),
        request.post(`${handle.baseURL}/api/v1/vault/switch`, {
          data: { path: vaultB2 },
        }),
      ]);

      const statuses = [r1.status(), r2.status()].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const conflictResp = r1.status() === 409 ? r1 : r2;
      const body = (await conflictResp.json()) as { error?: string; current_target?: string };
      expect(body.error).toBe("vault_switch_in_progress");
    } finally {
      await handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vaultA, { recursive: true, force: true });
      fs.rmSync(vaultB1, { recursive: true, force: true });
      fs.rmSync(vaultB2, { recursive: true, force: true });
    }
  });
});
