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

// ─── Helper: bootstrap a vault via /vault/create (used by 17d switch tests) ──

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
 * Playwright's stock toBeVisible() returns true for an unstyled div whose
 * children give it any non-zero size — so a modal whose CSS classes were
 * never written passes toBeVisible() while looking nothing like a modal.
 *
 * UAT-2 #1c surfaced exactly this: vault-picker-overlay / vault-picker-modal
 * had zero CSS rules; the picker mounted but had no fixed positioning, no
 * backdrop, no centering. The agent's existing toBeVisible() check passed.
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

test.describe("Phase 8 vault picker — make-build smoke (Plan 08-17c)", () => {
  test("no-vault boot shows the picker with create+open tabs (default = create)", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-vault-e2e-app-"));
    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      // The picker dialog should be visible AND actually painted (not just an
      // unstyled div passing toBeVisible with a tiny text-only bounding box).
      // UAT-2 #1c — without these size assertions, the missing-CSS regression
      // would have shipped to UAT again.
      const picker = page.getByRole("dialog", { name: /vault/i });
      await expectActuallyPainted(picker, {
        minWidth: 400,
        minHeight: 300,
        description: "vault picker modal",
      });

      // The backdrop overlay must cover the viewport — assert it's at least
      // most of the screen so a missing position:fixed / inset:0 fails the gate.
      const viewport = page.viewportSize();
      const minOverlayW = viewport ? Math.floor(viewport.width * 0.9) : 800;
      const minOverlayH = viewport ? Math.floor(viewport.height * 0.9) : 600;
      await expectActuallyPainted(page.locator(".vault-picker-overlay"), {
        minWidth: minOverlayW,
        minHeight: minOverlayH,
        description: "vault picker overlay backdrop",
      });

      // Strong header — title "Choose a vault" with a subtitle, not just "Vault".
      await expect(page.getByRole("heading", { name: /choose a vault/i })).toBeVisible();

      // Tab labels — no ellipses per UAT-2 #1d.
      await expect(page.getByRole("tab", { name: "Open existing", exact: true })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Create new", exact: true })).toBeVisible();

      // No recents on first boot → default tab is "create new"
      await expect(page.getByRole("tab", { name: "Create new", exact: true })).toHaveAttribute("aria-selected", "true");

      // MCP must NOT appear in vault creation per UAT-2 #1d ("new vault is always empty").
      await expect(page.getByRole("checkbox", { name: /enable mcp/i })).toHaveCount(0);
      await expect(page.getByText(/edit only \(create \+ update\)/i)).toHaveCount(0);

      // Path input must be full-width and visually styled (border + background).
      // Width ≥ 400 catches the "no CSS, default browser width" regression.
      await expectActuallyPainted(page.getByTestId("vault-create-path-input"), {
        minWidth: 400,
        minHeight: 28,
        description: "vault path input",
      });

      // Daily template textarea must be pre-filled with the backend default and
      // be a fully styled, multi-line surface (catches "invisible textarea" regression).
      const ta = page.getByRole("textbox", { name: /daily note template/i });
      await expect(ta).toHaveValue("# {{date}}\n\n");
      await expectActuallyPainted(ta, { minWidth: 400, minHeight: 80, description: "daily template textarea" });

      // Submit button must be present, visible, and styled as a real button
      // (catches "no submit button" UAT-2 #1d blocker).
      const submitBtn = page.getByTestId("vault-create-submit");
      await expectActuallyPainted(submitBtn, { minWidth: 100, minHeight: 32, description: "Create vault button" });
      await expect(submitBtn).toHaveText(/create vault/i);
      // Disabled while path is empty.
      await expect(submitBtn).toBeDisabled();
      // Typing a valid absolute path enables it.
      await page.getByTestId("vault-create-path-input").fill("/tmp/jasper-uat-2-1d-smoke");
      await expect(submitBtn).toBeEnabled();
      // Don't actually submit here — that's covered by the next test.

      // Theme picker live-applies. Pick light, html should flip; pick dark, flip back.
      await page.getByRole("radio", { name: /light/i }).check();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.getByRole("radio", { name: /dark/i }).check();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
    }
  });

  test("folder picker — browse, click into a subfolder, select returns that path", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-fs-pick-app-"));
    // Build a known directory tree under the OS tmp dir so we can navigate
    // to a deterministic subfolder name regardless of $HOME's contents.
    const browseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-fs-pick-root-"));
    const targetSub = "uat-picker-target";
    fs.mkdirSync(path.join(browseRoot, targetSub));
    fs.mkdirSync(path.join(browseRoot, "another-sibling"));

    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      // Pre-fill the input with the deterministic tmp root so Browse opens there
      // (the picker uses the input as its initial path when non-empty).
      await page.getByTestId("vault-create-path-input").fill(browseRoot);
      await page.getByTestId("vault-create-browse").click();

      // FolderPicker modal mounts above the vault picker.
      const folderPicker = page.getByTestId("folder-picker");
      await expectActuallyPainted(folderPicker, {
        minWidth: 400,
        minHeight: 300,
        description: "folder picker modal",
      });

      // Current path shows the canonical root we started from. macOS resolves
      // /var/folders/... to /private/var/folders/..., so accept either prefix.
      await expect(page.getByTestId("folder-picker-current-path")).toContainText(
        new RegExp(path.basename(browseRoot)),
      );

      // Entries list contains our two seeded subdirs alphabetically.
      const entries = page.getByTestId("folder-picker-entries");
      await expect(entries.locator("button")).toHaveCount(2);
      await expect(entries.locator("button").first()).toContainText("another-sibling");

      // Click into the target subfolder.
      await page.getByTestId(`folder-picker-entry-${targetSub}`).click();
      await expect(page.getByTestId("folder-picker-current-path")).toContainText(targetSub);

      // Select returns the absolute path to the create form's input.
      await page.getByTestId("folder-picker-select").click();
      // FolderPicker closes; vault picker still open with input populated.
      await expect(folderPicker).toHaveCount(0);
      const inputValue = await page.getByTestId("vault-create-path-input").inputValue();
      expect(inputValue).toContain(targetSub);
      expect(path.isAbsolute(inputValue)).toBe(true);
    } finally {
      handle?.kill();
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

      // Open the folder picker via the create form's Browse… button.
      await page.getByTestId("vault-create-path-input").fill(browseRoot);
      await page.getByTestId("vault-create-browse").click();
      await expect(page.getByTestId("folder-picker")).toBeVisible();

      // Double-click the breadcrumb bar (not on a segment button).
      const crumb = page.getByTestId("folder-picker-breadcrumb");
      await crumb.dblclick();

      // Input appears, pre-filled with the current canonical path.
      const pathInput = page.getByTestId("folder-picker-path-input");
      await expect(pathInput).toBeVisible();
      const prefilled = await pathInput.inputValue();
      expect(path.isAbsolute(prefilled)).toBe(true);

      // Type the deep target and submit with Enter.
      await pathInput.fill(jumpTarget);
      await pathInput.press("Enter");

      // Edit mode exits on success → breadcrumb back, current path reflects the jump.
      await expect(page.getByTestId("folder-picker-path-input")).toHaveCount(0);
      await expect(page.getByTestId("folder-picker-current-path")).toContainText(
        path.basename(jumpTarget),
      );

      // Select propagates the absolute path back to the create form.
      await page.getByTestId("folder-picker-select").click();
      const inputValue = await page.getByTestId("vault-create-path-input").inputValue();
      expect(inputValue).toContain(path.basename(jumpTarget));
    } finally {
      handle?.kill();
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
    // Seed a .jasper/ so the backend reports is_vault: true for this folder.
    fs.mkdirSync(path.join(existingVault, ".jasper"));
    fs.mkdirSync(path.join(browseRoot, "PlainFolder"));

    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await page.goto(handle.baseURL + "/");

      // Open the picker via the create form's Browse… button.
      await page.getByTestId("vault-create-path-input").fill(browseRoot);
      await page.getByTestId("vault-create-browse").click();
      await expect(page.getByTestId("folder-picker")).toBeVisible();

      // No vault detected at the browseRoot itself.
      await expect(page.getByTestId("folder-picker-vault-banner")).toHaveCount(0);
      await expect(page.getByTestId("folder-picker-select")).toBeVisible();

      // Click into the seeded vault folder.
      await page.getByTestId("folder-picker-entry-ExistingVault").click();

      // Banner appears + footer flips.
      await expect(page.getByTestId("folder-picker-vault-banner")).toContainText(
        /already a Jasper vault/i,
      );
      await expect(page.getByTestId("folder-picker-open-vault")).toBeVisible();
      await expect(page.getByTestId("folder-picker-go-up")).toBeVisible();
      await expect(page.getByTestId("folder-picker-select")).toHaveCount(0);

      // Go up navigates the picker to the parent — banner clears.
      await page.getByTestId("folder-picker-go-up").click();
      await expect(page.getByTestId("folder-picker-vault-banner")).toHaveCount(0);
      await expect(page.getByTestId("folder-picker-current-path-primary")).toContainText(
        path.basename(browseRoot),
      );
      // Picker is still open — Cancel did NOT close it.
      await expect(page.getByTestId("folder-picker")).toBeVisible();
    } finally {
      handle?.kill();
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

      // Open the inline new-folder input.
      await page.getByTestId("folder-picker-new-folder-button").click();
      const nameInput = page.getByTestId("folder-picker-new-folder-input");
      await expect(nameInput).toBeVisible();

      // Type a name with mixed case + spaces so the test also covers
      // the case-preservation fix on darwin (the backend would otherwise
      // lowercase via vault.Canonicalize).
      const targetName = "Brand New Vault";
      await nameInput.fill(targetName);
      await nameInput.press("Enter");

      // Inline input closes on success.
      await expect(nameInput).toHaveCount(0);
      // The new folder is now in the listing.
      await expect(
        page.getByTestId(`folder-picker-entry-${targetName}`),
      ).toBeVisible({ timeout: 5_000 });
      // And on disk, with the case preserved.
      expect(fs.existsSync(path.join(browseRoot, targetName))).toBe(true);
    } finally {
      handle?.kill();
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

// ─── Plan 08-17d: vault switch flow E2E tests ────────────────────────────────

test.describe("Phase 8 vault switch — make-build smoke (Plan 08-17d)", () => {
  /**
   * Test: switch from vault A to vault B.
   *
   * Steps:
   *   1. Create two vaults A and B on disk via /vault/create.
   *   2. Open A so the main shell is visible with A's name in the StatusBar.
   *   3. Open the vault picker in switch mode via StatusBar click.
   *   4. Click vault B's row in the Recent tab.
   *   5. The VaultSwitchOverlay mounts (role=dialog "Switching vault").
   *   6. SPA reloads; StatusBar shows B's display_name.
   *
   * Note: The overlay may appear and disappear quickly (server teardown + reopen
   * can be sub-second in the test environment). The assertion is on the FINAL
   * state (B open in StatusBar) which is load-bearing, with a generous timeout.
   */
  test("switch from vault A to vault B — SPA reloads to new vault, StatusBar shows B", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-app-"));
    const vaultA = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-A-"));
    const vaultB = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-B-"));
    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);

      // Bootstrap both vaults and open A as current.
      await bootstrapVault(handle.baseURL, vaultA);
      await bootstrapVault(handle.baseURL, vaultB);
      await openVault(handle.baseURL, vaultA);

      // Navigate to the app — should see main shell with A open.
      await page.goto(handle.baseURL + "/");
      await expect(page.getByTestId("status-bar-vault")).toBeVisible({ timeout: 10_000 });

      // StatusBar shows A's display_name (base of tmpdir path).
      const nameA = path.basename(vaultA);
      await expect(page.getByTestId("status-bar-vault")).toContainText(nameA.substring(0, 8), { timeout: 5_000 });

      // Click StatusBar to open vault picker in switch mode.
      await page.getByTestId("status-bar-vault").click();
      await expect(page.getByRole("dialog", { name: /vault/i })).toBeVisible({ timeout: 5_000 });

      // Navigate to Recent tab and click vault B's row.
      await page.getByRole("tab", { name: /recent/i }).click();
      const nameB = path.basename(vaultB);
      // Find and click vault B row — the row has data-testid=vault-row-<path>.
      await page.getByTestId(`vault-row-${vaultB}`).click({ timeout: 5_000 });

      // After the SPA reloads, StatusBar should show B's display_name.
      // Generous timeout: teardown + reopen + page reload takes a few seconds.
      await page.waitForFunction(
        (name) => {
          const el = document.querySelector('[data-testid="status-bar-vault"]');
          return el !== null && el.textContent !== null && el.textContent.includes(name.substring(0, 8));
        },
        nameB,
        { timeout: 20_000 },
      );
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vaultA, { recursive: true, force: true });
      fs.rmSync(vaultB, { recursive: true, force: true });
    }
  });

  /**
   * Test: concurrent switch returns 409 with vault_switch_in_progress.
   *
   * Fires two simultaneous POST /vault/switch requests. One should succeed
   * (200) and the other should be rejected (409) with `error: "vault_switch_in_progress"`.
   * We verify the status code distribution is exactly [200, 409] and that
   * the 409 body includes the error code.
   *
   * Uses the request fixture (not page) — this is a pure API test.
   */
  test("concurrent switch returns 409 with vault_switch_in_progress", async ({ request }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-409-app-"));
    const vaultA = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-409-A-"));
    const vaultB1 = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-409-B1-"));
    const vaultB2 = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-switch-409-B2-"));
    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);

      // Bootstrap all vaults; open A as current.
      await bootstrapVault(handle.baseURL, vaultA);
      await bootstrapVault(handle.baseURL, vaultB1);
      await bootstrapVault(handle.baseURL, vaultB2);
      await openVault(handle.baseURL, vaultA);

      // Fire two switch requests simultaneously.
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

      // The 409 body must name the error code.
      const conflictResp = r1.status() === 409 ? r1 : r2;
      const body = (await conflictResp.json()) as { error?: string; current_target?: string };
      expect(body.error).toBe("vault_switch_in_progress");
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vaultA, { recursive: true, force: true });
      fs.rmSync(vaultB1, { recursive: true, force: true });
      fs.rmSync(vaultB2, { recursive: true, force: true });
    }
  });
});
