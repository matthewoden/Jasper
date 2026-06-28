/**
 * Phase 15 UAT — Tab System (TAB-01/02/05/07/10).
 *
 * Covers the end-to-end tab behaviors that are observable in the browser:
 *   TAB-01/02  open notes from the tree as tabs; re-opening an already-open
 *              note does NOT duplicate, it just activates the existing tab.
 *   TAB-05     middle-click a tab pill closes it.
 *   TAB-07     enough open tabs overflow the strip → the overflow dropdown
 *              appears and selecting a hidden tab activates it.
 *   TAB-10     tabs + active tab persist across a full page reload (per vault);
 *              switching vaults clears the strip for the new vault's session.
 *
 * Manual-only (per 15-VALIDATION.md — NOT asserted here): Ctrl+Tab cycle and
 * CM6 scroll/cursor preservation across hide/show. These need real focus +
 * native key timing that the headless harness cannot deterministically prove.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive step uses a web-first
 * assertion (expect / expect.poll). Selectors:
 *   - Tab strip:      [data-testid="tab-strip"]
 *   - Tab pill:       role="tab" scoped inside the strip
 *   - Overflow btn:   [aria-label="Show hidden tabs"]
 *   - Tree note row:  [data-tree-row="<id>"][data-tree-row-kind="note"]
 *   - Connection dot: [data-testid="connection-status-dot"][data-status="connected"]
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

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

function tabStrip(page: Page): Locator {
  return page.getByTestId("tab-strip");
}

/** All tab pills currently rendered in the strip (excludes overflow-hidden). */
function tabPills(page: Page): Locator {
  return tabStrip(page).getByRole("tab");
}

function noteRow(page: Page, id: string): Locator {
  return page.locator(`[data-tree-row="${id}"][data-tree-row-kind="note"]`);
}

/** Open a tree note by clicking its row; waits for the row to be visible first. */
async function openNoteFromTree(page: Page, id: string): Promise<void> {
  const row = noteRow(page, id);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
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
    const overflowBtn = page.getByRole("button", { name: "Show hidden tabs" });
    await expect(overflowBtn).toBeVisible({ timeout: 10_000 });

    // Open the dropdown and select the first overflow-hidden tab. The dropdown
    // only lists hidden (non-fitting) tabs, so its first item is guaranteed to
    // be a tab not currently shown in the strip.
    await overflowBtn.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const firstHidden = menu.getByRole("menuitem").first();
    await expect(firstHidden).toBeVisible();
    const hiddenTitle = (await firstHidden.textContent())?.trim() ?? "";
    expect(hiddenTitle).toMatch(/^overflow-note-\d\d-wwwwww$/);
    const hiddenId = ids[Number(hiddenTitle.slice("overflow-note-".length, "overflow-note-".length + 2))];
    await firstHidden.click();

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
    await expect
      .poll(
        () =>
          page.evaluate(([a, b]) => {
            const key = Object.keys(localStorage).find((k) =>
              k.startsWith("jasper.tabs."),
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

// ─── Vault-swap clear (TAB-10 / D-09) ────────────────────────────────────────
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
      mcp_enabled: false,
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

      // After the swap-driven reload, B's session has no tabs: the strip is
      // unmounted (renders null when empty). Poll for the connected dot first,
      // then assert zero pills.
      await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 20_000 },
      );
      await expect(tabStrip(page)).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vaultA, { recursive: true, force: true });
      fs.rmSync(vaultB, { recursive: true, force: true });
    }
  });
});

// ─── UAT-15.1: tab UX fixes (DnD, width, X-pin, breadcrumb) ──────────────────

// UAT-DND: drag-to-reorder
test.describe("@phase15 UAT-15.1-DND: drag-to-reorder tabs", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("dragging one pill past another reorders the strip", async ({ page }) => {
    await waitForConnected(page, jasper.baseURL);
    const idAlpha = await apiCreateNote(page, jasper.baseURL, "drag-alpha");
    const idBeta = await apiCreateNote(page, jasper.baseURL, "drag-beta");
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);
    await expect(tabPills(page)).toHaveCount(2);

    // Confirm initial order before dragging.
    const initialTexts = (await tabPills(page).allTextContents()).map((t) =>
      t.trim(),
    );
    expect(initialTexts).toEqual(["drag-alpha", "drag-beta"]);

    // Drive reorder via a shared DataTransfer so React's synthetic handlers receive a
    // DataTransfer carrying the tabId across the dragstart → drop sequence.
    // DataTransfer constructed with new DataTransfer() starts in readwrite mode so
    // setData/getData work without native-drag browser restrictions.
    await page.evaluate(() => {
      const strip = document.querySelector(
        '[data-testid="tab-strip"]',
      ) as HTMLElement | null;
      if (!strip) throw new Error("tab-strip not found");
      const pills = strip.querySelectorAll('[role="tab"]');
      if (pills.length < 2) throw new Error("need ≥2 pills");
      const source = pills[0] as HTMLElement;
      const target = pills[1] as HTMLElement;
      const dt = new DataTransfer();
      source.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );
      target.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );
      source.dispatchEvent(
        new DragEvent("dragend", { bubbles: true, dataTransfer: dt }),
      );
    });

    // Poll until React has re-rendered the settled reordered state.
    await expect
      .poll(
        async () =>
          (await tabPills(page).allTextContents()).map((t) => t.trim()),
        { timeout: 5_000 },
      )
      .toEqual(["drag-beta", "drag-alpha"]);
  });
});

// UAT-WIDTH: responsive width — editor stays within viewport
test.describe("@phase15 UAT-15.1-WIDTH: responsive editor width", () => {
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
    const overflowBtn = page.getByRole("button", { name: "Show hidden tabs" });
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
test.describe("@phase15 UAT-15.1-XPIN: close X pinned to right edge", () => {
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
test.describe("@phase15 UAT-15.1-BREADCRUMB: centered breadcrumb trail", () => {
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
    // Nested note: path = "breadcrumbs/nested.md" → breadcrumb = "breadcrumbs / nested"
    const nestedId = await apiCreateNote(
      page,
      jasper.baseURL,
      "nested",
      "breadcrumbs",
    );

    // Open root note (only 1 tab — 1 breadcrumb element).
    await openNoteFromTree(page, rootId);
    const rootBc = page.getByTestId("note-breadcrumb");
    await expect(rootBc).toBeVisible({ timeout: 5_000 });
    await expect(rootBc).toHaveText("root-crumb");
    const rootAlign = await rootBc.evaluate(
      (el) => getComputedStyle(el).textAlign,
    );
    expect(rootAlign).toBe("center");

    // Expand "breadcrumbs" folder, then open nested note.
    const folderRow = page.locator(
      '[data-tree-row="breadcrumbs"][data-tree-row-kind="folder"]',
    );
    await expect(folderRow).toBeVisible({ timeout: 5_000 });
    await folderRow.click();
    await openNoteFromTree(page, nestedId);

    // 2 tabs open; filter by text to get the visible (active) breadcrumb.
    const nestedBc = page
      .getByTestId("note-breadcrumb")
      .filter({ hasText: "breadcrumbs / nested" });
    await expect(nestedBc).toBeVisible({ timeout: 5_000 });
    await expect(nestedBc).toHaveText("breadcrumbs / nested");
    const nestedAlign = await nestedBc.evaluate(
      (el) => getComputedStyle(el).textAlign,
    );
    expect(nestedAlign).toBe("center");
  });
});
