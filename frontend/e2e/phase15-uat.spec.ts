/**
 * Ctrl+Tab cycling and CM6 scroll/cursor preservation across hide/show are
 * deliberately NOT asserted — both need real focus and native key timing the
 * headless harness cannot prove deterministically. They stay manual.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { openNoteFromTree, noteRow } from "./helpers/openNoteFromTree";

// ─── Shared helpers (single-vault path) ──────────────────────────────────────

/**
 * Spawn a binary with an isolated JASPER_APP_HOME so GET /vault/current returns
 * THIS test's ephemeral vault — not whatever vault a parallel worker last
 * opened in the shared default app home. The vault path is the localStorage tab
 * key, so without isolation the reload/persistence key would be non-deterministic
 * across workers (zero tolerance for flake). Returns the handle + the appHome to
 * clean up.
 */
async function spawnIsolated(): Promise<{ jasper: JasperHandle; appHome: string }> {
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-p15-apphome-"));
  const jasper = await spawnJasper({ env: { JASPER_APP_HOME: appHome } });
  return { jasper, appHome };
}

async function waitForConnected(page: Page, baseURL: string): Promise<void> {
  await page.goto(baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

/** Create a note via the API; returns its UUID. */
async function apiCreateNote(
  page: Page,
  baseURL: string,
  title: string,
  parentPath = "",
): Promise<string> {
  const resp = await page.request.post(`${baseURL}/api/v1/notes`, {
    data: { parent_path: parentPath, title },
  });
  if (resp.status() !== 201) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`apiCreateNote ${title}: ${String(resp.status())} ${body}`);
  }
  return ((await resp.json()) as { id: string }).id;
}

/** Create a folder via the API (parent_path="" = vault root). */
async function apiCreateFolder(
  page: Page,
  baseURL: string,
  name: string,
  parentPath = "",
): Promise<void> {
  const resp = await page.request.post(`${baseURL}/api/v1/folders`, {
    data: { parent_path: parentPath, name },
  });
  if (resp.status() !== 201) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateFolder ${name}: ${String(resp.status())} ${body}`,
    );
  }
}

function tabStrip(page: Page): Locator {
  return page.getByTestId("tab-strip");
}

/** All tab pills currently rendered in the strip (excludes overflow-hidden). */
function tabPills(page: Page): Locator {
  return tabStrip(page).getByRole("tab");
}

// ─── TAB-01/02 — open + dedup + active switch ────────────────────────────────

test.describe("@phase15 TAB-01/02: open and switch tabs", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("opening two notes shows two pills; re-opening an open note does not duplicate", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "tab-alpha");
    const idB = await apiCreateNote(page, jasper.baseURL, "tab-beta");

    await openNoteFromTree(page, idA);
    await expect(tabStrip(page)).toBeVisible();
    await expect(tabPills(page)).toHaveCount(1);

    await openNoteFromTree(page, idB);
    await expect(tabPills(page)).toHaveCount(2);

    // Re-open A → no third pill; A becomes the active tab.
    await openNoteFromTree(page, idA);
    await expect(tabPills(page)).toHaveCount(2);
    await expect(
      tabPills(page).filter({ hasText: "tab-alpha" }),
    ).toHaveAttribute("aria-selected", "true");

    // Clicking B's pill activates B.
    await tabPills(page).filter({ hasText: "tab-beta" }).click();
    await expect(
      tabPills(page).filter({ hasText: "tab-beta" }),
    ).toHaveAttribute("aria-selected", "true");
  });
});

// ─── TAB-05 — middle-click close ─────────────────────────────────────────────

test.describe("@phase15 TAB-05: middle-click closes a tab", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("middle-clicking a pill removes it from the strip", async ({ page }) => {
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "mid-one");
    const idB = await apiCreateNote(page, jasper.baseURL, "mid-two");
    await openNoteFromTree(page, idA);
    await openNoteFromTree(page, idB);
    await expect(tabPills(page)).toHaveCount(2);

    await tabPills(page)
      .filter({ hasText: "mid-two" })
      .click({ button: "middle" });

    await expect(tabPills(page)).toHaveCount(1);
    await expect(tabPills(page).filter({ hasText: "mid-two" })).toHaveCount(0);
  });
});

// ─── TAB-07 — overflow dropdown ──────────────────────────────────────────────

test.describe("@phase15 TAB-07: overflow dropdown", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("opening many notes overflows the strip; hidden tab selectable via dropdown", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);

    // Open enough wide-titled notes that they cannot all fit (each pill is
    // 80–200px wide; the editor-column strip is ~1020px, so >7 tabs overflow).
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const title = `overflow-note-${String(i).padStart(2, "0")}-wwwwww`;
      ids.push(await apiCreateNote(page, jasper.baseURL, title));
    }
    for (const id of ids) {
      await openNoteFromTree(page, id);
    }

    // Overflow appears once the open tabs exceed the strip width (TAB-07).
    const overflowBtn = page.getByRole("button", { name: "Show all tabs" });
    await expect(overflowBtn).toBeVisible({ timeout: 10_000 });

    // The dropdown is always visible and lists EVERY
    // open tab now, not just the ones hidden by overflow — so find one whose
    // title is NOT already shown as a pill to prove the click genuinely
    // exercises the dropdown-select path for a collapsed tab.
    const visiblePillTitles = new Set(
      (await tabPills(page).allTextContents()).map((t) => t.trim()),
    );

    await overflowBtn.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const items = menu.getByRole("menuitem");
    await expect(items).toHaveCount(ids.length);

    let hiddenItem: Locator | null = null;
    let hiddenTitle = "";
    const itemCount = await items.count();
    for (let i = 0; i < itemCount; i++) {
      const item = items.nth(i);
      const text = (await item.textContent())?.trim() ?? "";
      if (!visiblePillTitles.has(text)) {
        hiddenItem = item;
        hiddenTitle = text;
        break;
      }
    }
    expect(hiddenItem).not.toBeNull();
    expect(hiddenTitle).toMatch(/^overflow-note-\d\d-wwwwww$/);
    const hiddenId = ids[Number(hiddenTitle.slice("overflow-note-".length, "overflow-note-".length + 2))];
    await hiddenItem!.click();

    // Selecting a hidden tab activates it: the active tab drives
    // useTreeStore.activeNoteId, which marks the matching tree row active
    // (data-active="true") — a deterministic, design-faithful signal.
    await expect(noteRow(page, hiddenId)).toHaveAttribute(
      "data-active",
      "true",
      { timeout: 10_000 },
    );
  });
});

// ─── TAB-10 — reload persistence ─────────────────────────────────────────────

test.describe("@phase15 TAB-10: tabs persist across reload", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("open tabs + active tab survive a full page reload", async ({ page }) => {
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "persist-a");
    const idB = await apiCreateNote(page, jasper.baseURL, "persist-b");
    await openNoteFromTree(page, idA);
    await openNoteFromTree(page, idB);
    await expect(tabPills(page)).toHaveCount(2);
    // B is the active tab (last opened).
    await expect(
      tabPills(page).filter({ hasText: "persist-b" }),
    ).toHaveAttribute("aria-selected", "true");

    // Tab persistence is debounced (~250ms). Poll localStorage until BOTH tab
    // UUIDs are written before reloading — deterministic, never a fixed sleep.
    // persistence moved from the flat jasper.tabs.<vault> key to the
    // pane-tree's jasper.layout.<vault> key (usePaneStore) — the old key is
    // never written or migrated (pre-launch: no back-compat burden).
    await expect
      .poll(
        () =>
          page.evaluate(([a, b]) => {
            const key = Object.keys(localStorage).find((k) =>
              k.startsWith("jasper.layout."),
            );
            if (key === undefined) return false;
            const raw = localStorage.getItem(key) ?? "";
            return raw.includes(a) && raw.includes(b);
          }, [idA, idB]),
        { timeout: 5_000 },
      )
      .toBe(true);

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Same two tabs restore (poll the strip — never a fixed sleep).
    await expect(tabPills(page)).toHaveCount(2, { timeout: 10_000 });
    await expect(tabPills(page).filter({ hasText: "persist-a" })).toHaveCount(1);
    await expect(tabPills(page).filter({ hasText: "persist-b" })).toHaveCount(1);
    // Active tab is preserved.
    await expect(
      tabPills(page).filter({ hasText: "persist-b" }),
    ).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
  });
});

// ─── Vault-swap clear (TAB-10) ────────────────────────────────────────
//
// This needs two vaults under one JASPER_APP_HOME so the StatusBar vault picker
// can switch between them. Self-contained spawn helper mirrors phase8-vault.

const __filename15 = fileURLToPath(import.meta.url);
const __dirname15 = path.dirname(__filename15);
// This spec lives at frontend/e2e/ — two hops up reaches the repo root.
const repoRoot15 = path.resolve(__dirname15, "..", "..");
const JASPER_BIN15 = path.join(repoRoot15, "bin", "jasper");

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
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

function canonVaultPath(p: string): string {
  const real = fs.realpathSync(p);
  return process.platform === "darwin" ? real.toLowerCase() : real;
}

interface VaultHandle {
  proc: ChildProcess;
  baseURL: string;
  kill: () => Promise<void>;
}

async function spawnVaultJasper(appHome: string): Promise<VaultHandle> {
  if (!fs.existsSync(JASPER_BIN15)) {
    throw new Error(
      `bin/jasper missing — run \`make build\` first (CLAUDE.md §Build & embed pipeline). Expected at: ${JASPER_BIN15}`,
    );
  }
  const port = await findFreePort();
  const mcpPort = await findFreePort();
  const proc = spawn(JASPER_BIN15, ["serve", "--bind", `127.0.0.1:${port}`], {
    env: { ...process.env, JASPER_APP_HOME: appHome, JASPER_MCP_PORT: String(mcpPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (b) => process.stderr.write(`[jasper] ${b}`));
  proc.stderr?.on("data", (b) => process.stderr.write(`[jasper] ${b}`));
  const baseURL = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error("jasper exited before ready");
    try {
      const r = await fetch(`${baseURL}/api/v1/admin/status`);
      if (r.status === 200) break;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    proc,
    baseURL,
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

async function bootstrapVault(baseURL: string, vaultDir: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/v1/vault/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: vaultDir,
      theme: "dark",
      daily_template: "",
    }),
  });
  if (!res.ok) throw new Error(`vault/create ${vaultDir}: ${res.status} ${await res.text()}`);
}

async function openVault(baseURL: string, vaultPath: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/v1/vault/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: vaultPath }),
  });
  if (!res.ok) throw new Error(`vault/open ${vaultPath}: ${res.status} ${await res.text()}`);
}

test.describe("@phase15 TAB-10: vault swap clears the tab strip", () => {
  test("switching from vault A (with open tabs) to vault B leaves B's strip empty", async ({
    page,
  }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-p15-app-"));
    const vaultA = canonVaultPath(fs.mkdtempSync(path.join(os.tmpdir(), "jasper-p15-A-")));
    const vaultB = canonVaultPath(fs.mkdtempSync(path.join(os.tmpdir(), "jasper-p15-B-")));
    let handle: VaultHandle | undefined;
    try {
      handle = await spawnVaultJasper(appHome);
      await bootstrapVault(handle.baseURL, vaultA);
      await bootstrapVault(handle.baseURL, vaultB);
      await openVault(handle.baseURL, vaultA);

      await page.goto(handle.baseURL + "/");
      await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 10_000 },
      );

      // Open a tab in vault A.
      const idA = await apiCreateNote(page, handle.baseURL, "vaultA-note");
      await openNoteFromTree(page, idA);
      await expect(tabPills(page)).toHaveCount(1);

      // Switch to vault B via the StatusBar vault picker.
      await page.getByTestId("status-bar-vault").click();
      await expect(page.getByRole("dialog", { name: /vault/i })).toBeVisible({
        timeout: 5_000,
      });
      await page.getByRole("tab", { name: /recent/i }).click();
      await page.getByTestId(`vault-row-${vaultB}`).click({ timeout: 5_000 });

      // After the swap-driven reload, B's session has no tabs. The strip
      // always renders (TAB-14 empty state: shows only the + button), so we
      // assert zero tab PILLS rather than zero strip elements.
      await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 20_000 },
      );
      await expect(tabPills(page)).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vaultA, { recursive: true, force: true });
      fs.rmSync(vaultB, { recursive: true, force: true });
    }
  });
});

// ─── Tab UX fixes (DnD, width, X-pin, breadcrumb) ───────────────────────────

// UAT-DND: drag-to-reorder (pointer-event implementation — real page.mouse drag)
// Synthetic DragEvent dispatch via page.evaluate is BANNED (round 1 false positive).
// All reorder proofs use page.mouse so the pointer-event handlers fire natively.
test.describe("@phase15 drag-to-reorder tabs", () => {
  let jasper: JasperHandle;
  let appHome: string;
  let idAlpha: string;
  let idBeta: string;
  let idGamma: string;

  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
    // Create notes via direct fetch — no page needed, avoids fixture coupling.
    const createNote = async (title: string): Promise<string> => {
      const resp = await fetch(`${jasper.baseURL}/api/v1/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent_path: "", title }),
      });
      if (!resp.ok) throw new Error(`create ${title}: ${resp.status}`);
      return ((await resp.json()) as { id: string }).id;
    };
    idAlpha = await createNote("drag-alpha");
    idBeta = await createNote("drag-beta");
    idGamma = await createNote("drag-gamma");
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("a small click (no movement) selects the pill without reordering", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    // Each test gets a fresh page — open the pre-created notes from the tree.
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);
    await expect(tabPills(page)).toHaveCount(2);

    // Confirm initial order.
    expect(
      (await tabPills(page).allTextContents()).map((t) => t.trim()),
    ).toEqual(["drag-alpha", "drag-beta"]);

    // Click pill 0 (drag-alpha) — this is a standard click, well under the 5px threshold.
    const pill0 = tabPills(page).nth(0);
    await pill0.click();

    // Order must be unchanged after a plain click.
    expect(
      (await tabPills(page).allTextContents()).map((t) => t.trim()),
    ).toEqual(["drag-alpha", "drag-beta"]);

    // The clicked pill must now be selected.
    await expect(pill0).toHaveAttribute("aria-selected", "true");
  });

  test("real page.mouse drag past pill[1]'s midpoint reorders the strip", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);

    // Each test gets a fresh page — open both notes so the strip shows 2 pills.
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);

    // Verify initial order before dragging.
    await expect(tabPills(page)).toHaveCount(2);
    expect(
      (await tabPills(page).allTextContents()).map((t) => t.trim()),
    ).toEqual(["drag-alpha", "drag-beta"]);

    // Read bounding boxes — poll until they resolve to non-zero dimensions.
    let pill0bbox = await tabPills(page).nth(0).boundingBox();
    let pill1bbox = await tabPills(page).nth(1).boundingBox();
    await expect
      .poll(
        async () => {
          pill0bbox = await tabPills(page).nth(0).boundingBox();
          pill1bbox = await tabPills(page).nth(1).boundingBox();
          return (
            (pill0bbox?.width ?? 0) > 0 && (pill1bbox?.width ?? 0) > 0
          );
        },
        { timeout: 5_000 },
      )
      .toBe(true);

    if (!pill0bbox || !pill1bbox) throw new Error("pill bounding boxes unavailable");

    // Start at pill0 center, drag to pill1 right edge (well past pill1's midpoint)
    // in multiple steps so intermediate pointermove events fire and the 5px drag
    // threshold is crossed. page.mouse events hit the real pointer-event handlers.
    const fromX = pill0bbox.x + pill0bbox.width / 2;
    const fromY = pill0bbox.y + pill0bbox.height / 2;
    const toX = pill1bbox.x + pill1bbox.width - 2;
    const toY = pill1bbox.y + pill1bbox.height / 2;

    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 10 });
    await page.mouse.up();

    // Poll until React re-renders the reordered state.
    await expect
      .poll(
        async () =>
          (await tabPills(page).allTextContents()).map((t) => t.trim()),
        { timeout: 5_000 },
      )
      .toEqual(["drag-beta", "drag-alpha"]);
  });

  test("ghost appears during active drag and is removed on mouse-up", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);
    await expect(tabPills(page)).toHaveCount(2);

    // Poll until bounding boxes settle to non-zero dimensions.
    let pill0bbox = await tabPills(page).nth(0).boundingBox();
    await expect
      .poll(
        async () => {
          pill0bbox = await tabPills(page).nth(0).boundingBox();
          return (pill0bbox?.width ?? 0) > 0;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    if (!pill0bbox) throw new Error("pill0 bounding box unavailable");

    const fromX = pill0bbox.x + pill0bbox.width / 2;
    const fromY = pill0bbox.y + pill0bbox.height / 2;

    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    // Move 30px past the 5px drag threshold so the strip activates the drag.
    await page.mouse.move(fromX + 30, fromY, { steps: 6 });

    // Ghost must be visible while the drag is active (before mouse-up).
    await expect(page.getByTestId("tab-drag-ghost")).toBeVisible({
      timeout: 3_000,
    });

    await page.mouse.up();

    // Ghost must be removed immediately after the drag ends.
    await expect(page.getByTestId("tab-drag-ghost")).toHaveCount(0, {
      timeout: 3_000,
    });
  });

  test("tab title user-select is none; no text selection survives a drag", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);
    await expect(tabPills(page)).toHaveCount(2);

    // Computed user-select must be "none" on every tab pill.
    const userSelect = await tabPills(page).first().evaluate((el) =>
      getComputedStyle(el).userSelect,
    );
    expect(userSelect).toBe("none");

    // After a real drag across tab titles, the selection must be empty.
    let pill0bbox = await tabPills(page).nth(0).boundingBox();
    let pill1bbox = await tabPills(page).nth(1).boundingBox();
    await expect
      .poll(
        async () => {
          pill0bbox = await tabPills(page).nth(0).boundingBox();
          pill1bbox = await tabPills(page).nth(1).boundingBox();
          return (pill0bbox?.width ?? 0) > 0 && (pill1bbox?.width ?? 0) > 0;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    if (!pill0bbox || !pill1bbox) throw new Error("pill bounding boxes unavailable");

    const fromX = pill0bbox.x + pill0bbox.width / 2;
    const fromY = pill0bbox.y + pill0bbox.height / 2;
    const toX = pill1bbox.x + pill1bbox.width / 2;
    const toY = fromY;

    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 8 });
    await page.mouse.up();

    // window.getSelection() must be empty — no text selected across tab titles.
    const selection = await page.evaluate(
      () => window.getSelection()?.toString() ?? "",
    );
    expect(selection.trim()).toBe("");
  });

  // POLISH-GHOST: the floating drag ghost is a real TabPill with a Close button,
  // not the previous title-only lightweight preview.
  test("FULL GHOST: floating preview is a real pill with a Close button", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);
    await expect(tabPills(page)).toHaveCount(2);

    // Poll until pill0 bounding box resolves to non-zero dimensions.
    let pill0bbox = await tabPills(page).nth(0).boundingBox();
    await expect
      .poll(
        async () => {
          pill0bbox = await tabPills(page).nth(0).boundingBox();
          return (pill0bbox?.width ?? 0) > 0;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    if (!pill0bbox) throw new Error("pill0 bounding box unavailable");

    const fromX = pill0bbox.x + pill0bbox.width / 2;
    const fromY = pill0bbox.y + pill0bbox.height / 2;

    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    // Move 30px past the 5px drag threshold so the strip activates the drag.
    await page.mouse.move(fromX + 30, fromY, { steps: 6 });

    // Ghost must be visible with a Close button inside it — proving full pill.
    await expect(page.getByTestId("tab-drag-ghost")).toBeVisible({
      timeout: 3_000,
    });
    // The Close button is inside the ghost's aria-hidden container; query with
    // includeHidden so Playwright finds it despite the aria-hidden parent.
    await expect(
      page.getByTestId("tab-drag-ghost").locator('button[aria-label^="Close"]'),
    ).toHaveCount(1);

    await page.mouse.up();
    await expect(page.getByTestId("tab-drag-ghost")).toHaveCount(0, {
      timeout: 3_000,
    });
  });

  // POLISH-OVERLAY: the insertion indicator is an absolute overlay that does not
  // shift stationary pills sideways when it appears (no 2px layout contribution).
  test("NO-REFLOW OVERLAY: indicator never shifts a stationary tab", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);
    await openNoteFromTree(page, idGamma);
    await expect(tabPills(page)).toHaveCount(3);

    // Poll until all three bounding boxes resolve to non-zero dimensions.
    let pill0bbox = await tabPills(page).nth(0).boundingBox();
    let pill1bbox = await tabPills(page).nth(1).boundingBox();
    let pill2bbox = await tabPills(page).nth(2).boundingBox();
    await expect
      .poll(
        async () => {
          pill0bbox = await tabPills(page).nth(0).boundingBox();
          pill1bbox = await tabPills(page).nth(1).boundingBox();
          pill2bbox = await tabPills(page).nth(2).boundingBox();
          return (
            (pill0bbox?.width ?? 0) > 0 &&
            (pill1bbox?.width ?? 0) > 0 &&
            (pill2bbox?.width ?? 0) > 0
          );
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    if (!pill0bbox || !pill1bbox || !pill2bbox)
      throw new Error("pill bounding boxes unavailable");

    // Record pill2 (drag-gamma) x BEFORE the drag — this is the stationary pill.
    const pill2xBefore = pill2bbox.x;

    // Start at pill0, move toward a position between pill0 and pill1 midpoints so
    // the indicator appears before pill1 without triggering a reorder threshold.
    const fromX = pill0bbox.x + pill0bbox.width / 2;
    const fromY = pill0bbox.y + pill0bbox.height / 2;
    // Target: just past pill0's right edge but before pill1's midpoint.
    const toX = pill0bbox.x + pill0bbox.width + 5;

    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, fromY, { steps: 10 });

    // While holding: indicator must be visible and position:absolute.
    await expect(page.getByTestId("tab-drop-indicator")).toBeVisible({
      timeout: 3_000,
    });
    const indicatorPos = await page
      .getByTestId("tab-drop-indicator")
      .evaluate((el) => getComputedStyle(el).position);
    expect(indicatorPos).toBe("absolute");

    // The stationary pill's x must not shift — prove no 2px flex shove.
    const pill2xDuring =
      (await tabPills(page).nth(2).boundingBox())?.x ?? -1;
    expect(Math.abs(pill2xDuring - pill2xBefore)).toBeLessThanOrEqual(1);

    await page.mouse.up();
  });
});

// tooltip (#1), overlap (#5), alignment (#6) — all need overflow
// Notes are created ONCE in beforeAll via direct API fetch (no page); each test
// opens them from the tree so fresh pages can re-establish the overflow state.
test.describe(
  "@phase15 overflow context fixes",
  () => {
    let jasper: JasperHandle;
    let appHome: string;
    const overflowNoteIds: string[] = [];

    test.beforeAll(async () => {
      ({ jasper, appHome } = await spawnIsolated());
      // Create 20 notes via direct fetch — no page needed, avoids 409 on re-create.
      for (let i = 0; i < 20; i++) {
        const title = `toa-note-${String(i).padStart(2, "0")}-wwwwwwww`;
        const resp = await fetch(`${jasper.baseURL}/api/v1/notes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parent_path: "", title }),
        });
        if (!resp.ok) throw new Error(`create ${title}: ${resp.status}`);
        overflowNoteIds.push(((await resp.json()) as { id: string }).id);
      }
    });
    test.afterAll(async () => {
      if (jasper) await jasper.kill();
      if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
    });

    /** Open the pre-created overflow notes from the tree, wait for overflow button. */
    async function openOverflowNotes(page: Page): Promise<void> {
      for (const id of overflowNoteIds) {
        await openNoteFromTree(page, id);
      }
      await expect(
        page.getByRole("button", { name: "Show all tabs" }),
      ).toBeVisible({ timeout: 15_000 });
    }

    test("overflow trigger has an accessible 'Show all tabs' name", async ({
      page,
    }) => {
      await waitForConnected(page, jasper.baseURL);
      await openOverflowNotes(page);
      // Native title= migrated to a shared Radix Tooltip +
      // aria-label (no more native title attribute on this control).
      const overflowBtn = page.getByRole("button", { name: "Show all tabs" });
      await expect(overflowBtn).toBeVisible();
      await expect(overflowBtn).toHaveAttribute("aria-label", "Show all tabs");
      await expect(overflowBtn).not.toHaveAttribute("title", /.+/);
    });

    test("overflow trigger does not intersect the last visible pill", async ({
      page,
    }) => {
      await waitForConnected(page, jasper.baseURL);
      await openOverflowNotes(page);

      const overflowBtn = page.getByRole("button", { name: "Show all tabs" });
      await expect(overflowBtn).toBeVisible();

      // Poll layout until both bounding boxes are non-zero.
      await expect
        .poll(
          async () => {
            const pills = tabPills(page);
            const count = await pills.count();
            if (count === 0) return false;
            const lastPill = pills.last();
            const overflowBox = await overflowBtn.boundingBox();
            const pillBox = await lastPill.boundingBox();
            if (!overflowBox || !pillBox) return false;
            // Non-overlapping: overflow trigger's left >= last pill's right.
            return overflowBox.x >= pillBox.x + pillBox.width;
          },
          { timeout: 5_000 },
        )
        .toBe(true);
    });

    test("close X, new-tab +, and overflow chevron centers are within ~2px", async ({
      page,
    }) => {
      await waitForConnected(page, jasper.baseURL);
      await openOverflowNotes(page);

      const overflowBtn = page.getByRole("button", { name: "Show all tabs" });
      await expect(overflowBtn).toBeVisible();

      // Poll until all three bounding boxes resolve to non-null.
      // Note: aria-selected is on the tab element itself (not a descendant), so
      // use .and() (locator intersection) rather than filter({ has: ... }) which
      // only matches descendants.
      await expect
        .poll(
          async () => {
            const activePill = tabPills(page).and(
              page.locator('[aria-selected="true"]'),
            );
            const closeBtn = activePill
              .locator('button[aria-label^="Close"]')
              .first();
            const newTabBtn = page.getByTestId("new-tab-button");

            const closeBbox = await closeBtn.boundingBox();
            const newTabBbox = await newTabBtn.boundingBox();
            const overflowBbox = await overflowBtn.boundingBox();

            if (!closeBbox || !newTabBbox || !overflowBbox) return null;

            return {
              closeY: closeBbox.y + closeBbox.height / 2,
              newTabY: newTabBbox.y + newTabBbox.height / 2,
              overflowY: overflowBbox.y + overflowBbox.height / 2,
            };
          },
          { timeout: 5_000 },
        )
        .not.toBeNull();

      // Re-read final settled values for assertions.
      const activePill = tabPills(page).and(
        page.locator('[aria-selected="true"]'),
      );
      const closeBbox = await activePill
        .locator('button[aria-label^="Close"]')
        .first()
        .boundingBox();
      const newTabBbox = await page.getByTestId("new-tab-button").boundingBox();
      const overflowBbox = await overflowBtn.boundingBox();

      expect(closeBbox).not.toBeNull();
      expect(newTabBbox).not.toBeNull();
      expect(overflowBbox).not.toBeNull();

      const closeY = closeBbox!.y + closeBbox!.height / 2;
      const newTabY = newTabBbox!.y + newTabBbox!.height / 2;
      const overflowY = overflowBbox!.y + overflowBbox!.height / 2;

      // All three icon centers must be within ~2px of each other.
      expect(Math.abs(closeY - newTabY)).toBeLessThanOrEqual(2);
      expect(Math.abs(closeY - overflowY)).toBeLessThanOrEqual(2);
    });
  },
);

// active styling (#3) and opaque inactive background (#4)
test.describe(
  "@phase15 active brightness and opaque inactive pill",
  () => {
    let jasper: JasperHandle;
    let appHome: string;
    test.beforeAll(async () => {
      ({ jasper, appHome } = await spawnIsolated());
    });
    test.afterAll(async () => {
      if (jasper) await jasper.kill();
      if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
    });

    test("active title has same font-weight as inactive, but brighter color", async ({
      page,
    }) => {
      await waitForConnected(page, jasper.baseURL);
      // Use non-overlapping names: "uat-alpha" does not contain "uat-beta" and vice versa.
      const idA = await apiCreateNote(page, jasper.baseURL, "uat-alpha");
      const idB = await apiCreateNote(page, jasper.baseURL, "uat-beta");
      await openNoteFromTree(page, idA);
      await openNoteFromTree(page, idB);
      // idB is the active tab (opened last).
      await expect(tabPills(page).filter({ hasText: "uat-beta" })).toHaveAttribute(
        "aria-selected",
        "true",
        { timeout: 5_000 },
      );

      // Click idA to make it active.
      await tabPills(page).filter({ hasText: "uat-alpha" }).click();
      await expect(tabPills(page).filter({ hasText: "uat-alpha" })).toHaveAttribute(
        "aria-selected",
        "true",
      );

      const activePill = tabPills(page).filter({ hasText: "uat-alpha" });
      const inactivePill = tabPills(page).filter({ hasText: "uat-beta" });

      // Read title spans inside each pill.
      const [activeWeight, inactiveWeight, activeColor, inactiveColor] =
        await page.evaluate(() => {
          const pills = document.querySelectorAll('[role="tab"]');
          const active = Array.from(pills).find(
            (p) => p.getAttribute("aria-selected") === "true",
          );
          const inactive = Array.from(pills).find(
            (p) => p.getAttribute("aria-selected") !== "true",
          );
          const aSpan = active?.querySelector("span");
          const iSpan = inactive?.querySelector("span");
          const cs = (el: Element | null | undefined) =>
            el ? getComputedStyle(el as HTMLElement) : null;
          return [
            cs(aSpan)?.fontWeight ?? "",
            cs(iSpan)?.fontWeight ?? "",
            cs(aSpan)?.color ?? "",
            cs(iSpan)?.color ?? "",
          ];
        });

      // Same font-weight (no bolding).
      expect(activeWeight).toBe(inactiveWeight);
      // Colors must differ — active is brighter (fg vs muted).
      expect(activeColor).not.toBe(inactiveColor);

      // Suppress unused-variable lint for pill locators (used above for context).
      void activePill;
      void inactivePill;
    });

    test("inactive pill has an opaque background (not transparent)", async ({
      page,
    }) => {
      await waitForConnected(page, jasper.baseURL);
      const idA = await apiCreateNote(page, jasper.baseURL, "opaque-active");
      const idB = await apiCreateNote(page, jasper.baseURL, "opaque-inactive");
      await openNoteFromTree(page, idA);
      await openNoteFromTree(page, idB);
      // idB is active. Click idA to make idB the inactive one.
      await tabPills(page).filter({ hasText: "opaque-active" }).click();
      await expect(
        tabPills(page).filter({ hasText: "opaque-active" }),
      ).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

      // Get the computed background-color of the INACTIVE pill (opaque-inactive).
      const bgColor = await tabPills(page)
        .filter({ hasText: "opaque-inactive" })
        .evaluate((el) => getComputedStyle(el).backgroundColor);

      // Transparent is represented as "rgba(0, 0, 0, 0)" in browsers.
      // An opaque background has alpha 1 and looks like "rgb(...)" or "rgba(..., 1)".
      expect(bgColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(bgColor).not.toBe("transparent");
      // The color should not have a trailing ", 0)" which indicates fully transparent.
      expect(bgColor).not.toMatch(/, 0\)$/);
    });
  },
);

// UAT-WIDTH: responsive width — editor stays within viewport
test.describe("@phase15 responsive editor width", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("many open tabs overflow into dropdown; editor pane stays within viewport", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        await apiCreateNote(
          page,
          jasper.baseURL,
          `overflow-uat-${String(i).padStart(2, "0")}-wwwwww`,
        ),
      );
    }
    for (const id of ids) {
      await openNoteFromTree(page, id);
    }

    // Primary: overflow dropdown must appear — tabs shrank then overflowed.
    const overflowBtn = page.getByRole("button", { name: "Show all tabs" });
    await expect(overflowBtn).toBeVisible({ timeout: 10_000 });

    // Secondary: active editor pane bounding box fits within viewport width.
    const vw = page.viewportSize()?.width ?? 1280;
    await expect
      .poll(
        async () => {
          return page.evaluate(() => {
            const panes = document.querySelectorAll(
              '[data-testid="editor-pane"]',
            );
            for (const pane of panes) {
              const el = pane as HTMLElement;
              if (el.style.display !== "none") {
                const r = el.getBoundingClientRect();
                return r.x + r.width;
              }
            }
            return 0;
          });
        },
        { timeout: 5_000 },
      )
      .toBeLessThanOrEqual(vw + 1);
  });
});

// UAT-XPIN: close X is pinned to the pill's right edge
test.describe("@phase15 close X pinned to right edge", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("close button right edge is within 12px of pill right edge even for a short title", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    const id = await apiCreateNote(page, jasper.baseURL, "x");
    await openNoteFromTree(page, id);
    await expect(tabPills(page).filter({ hasText: "x" })).toBeVisible({
      timeout: 5_000,
    });

    // Poll bounding boxes — layout may settle after first paint.
    await expect
      .poll(
        async () => {
          const pill = tabStrip(page).getByRole("tab").filter({ hasText: "x" });
          const btn = pill.locator('button[aria-label^="Close"]');
          const pillBbox = await pill.boundingBox();
          const btnBbox = await btn.boundingBox();
          if (!pillBbox || !btnBbox) return 999;
          return Math.abs(
            pillBbox.x + pillBbox.width - (btnBbox.x + btnBbox.width),
          );
        },
        { timeout: 5_000 },
      )
      .toBeLessThanOrEqual(12);
  });
});

// UAT-BREADCRUMB: centered breadcrumb shows full path
test.describe("@phase15 centered breadcrumb trail", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("root note shows title-only; nested note shows folder / title; both centered", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);

    // Root note: path = "root-crumb.md" → breadcrumb = "root-crumb"
    const rootId = await apiCreateNote(page, jasper.baseURL, "root-crumb", "");
    // Create the parent folder before the nested note (server requires it to exist).
    await apiCreateFolder(page, jasper.baseURL, "breadcrumbs", "");
    // Nested note: path = "breadcrumbs/nested.md" → breadcrumb = "breadcrumbs / nested"
    const nestedId = await apiCreateNote(
      page,
      jasper.baseURL,
      "nested",
      "breadcrumbs",
    );

    // Open root note (only 1 tab — 1 breadcrumb element). The breadcrumb's
    // interactive path segments live in their own child row (word count moved
    // out entirely, to the bottom StatusBar), which is now
    // horizontally centered in the FULL
    // top-chrome bar rather than left-aligned to the title/body column.
    // Assert the path via the per-segment buttons (feature survived) rather
    // than any whole-nav textContent/alignment assumption.
    await openNoteFromTree(page, rootId);
    const rootBc = page.getByTestId("note-breadcrumb");
    await expect(rootBc).toBeVisible({ timeout: 5_000 });
    // Root note: title-only trail → exactly one segment "root-crumb".
    await expect(rootBc.getByTestId("breadcrumb-segment")).toHaveText([
      "root-crumb",
    ]);

    // Expand "breadcrumbs" folder, then open nested note.
    const folderRow = page.locator(
      '[data-tree-row="breadcrumbs"][data-tree-row-kind="folder"]',
    );
    await expect(folderRow).toBeVisible({ timeout: 5_000 });
    await folderRow.click();
    await openNoteFromTree(page, nestedId);

    // 2 tabs open; select the nested pane's breadcrumb by the "nested" segment it
    // contains. (The separator is now a CSS-margin "/" with no literal surrounding
    // spaces, so a "breadcrumbs / nested" whole-text filter no longer matches.)
    const nestedBc = page.getByTestId("note-breadcrumb").filter({
      has: page.getByTestId("breadcrumb-segment").filter({ hasText: "nested" }),
    });
    await expect(nestedBc).toBeVisible({ timeout: 5_000 });
    // Nested note: folder + title trail → segments "breadcrumbs" then "nested".
    await expect(nestedBc.getByTestId("breadcrumb-segment")).toHaveText([
      "breadcrumbs",
      "nested",
    ]);
  });
});
