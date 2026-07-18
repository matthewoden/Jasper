/**
 * Phase 25 UAT — Split-Pane Foundation (WS-03/04/07/08/10).
 *
 * Implemented in Plan 09 against the integrated split-pane UI (PaneTree /
 * LeafPane / usePaneStore / sharedDocRegistry landed in Waves 1-6). Covers
 * the end-to-end pane behaviors observable in the browser, matching the 4
 * ROADMAP.md success criteria for this phase:
 *   WS-03        each pane has its own independent tab strip, active tab, and
 *                breadcrumb — opening/switching a tab in one pane never
 *                affects another pane's tab strip.
 *   WS-04        closing the last tab in a leaf collapses that leaf; the
 *                sibling subtree fills the freed space (rebalance). The
 *                final remaining pane never collapses (D-10).
 *   WS-07/WS-08  active-pane tracking (keyboard/palette target the active
 *                pane; singletons like RightRail/StatusBar retarget on
 *                pane-focus change) AND the full layout — tree, active pane,
 *                ratios — persists across a full page reload, per vault.
 *   WS-10        the same note open in two panes shares one live document:
 *                edits in one pane are mirrored into the other, and there is
 *                exactly one save-state machine for the note (not one per
 *                pane).
 *
 * Selector contract (stable across Wave 0 → Plan 09 implementation):
 *   - Leaf pane:        [data-testid="leaf-pane"]
 *   - Per-leaf tab strip (scoped WITHIN a leaf): [data-testid="tab-strip"]
 *   - Active-pane marker: [data-active-pane="true"]
 *   - Split divider:    [data-testid="pane-divider"]
 *
 * Split/focus-cycle actions are invoked through the command palette (Cmd+P,
 * mode="commands") rather than their raw keyboard shortcuts (Cmd+\ / Cmd+Alt+
 * Arrow, D-14, appShortcuts.ts). appShortcuts.ts's handleAppSplitRight/
 * handleAppSplitDown/handleAppFocusNextPane/handleAppFocusPrevPane share an
 * `isTypingTarget()` do-not-hijack-typing guard that no-ops while a
 * contenteditable (CM6's `.cm-content`) has focus — which it does immediately
 * after opening any note. Cmd+P is NOT guarded that way (handleAppCmdP fires
 * unconditionally), so routing through the palette is the deterministic path
 * regardless of what currently has focus; App.tsx's commandActions.onSplitRight
 * etc. dispatch into the exact same usePaneStore actions the raw shortcuts do.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive step uses a web-first
 * assertion (expect / expect.poll), mirroring `phase15-uat.spec.ts`'s
 * existing discipline. The reload + shared-buffer scenarios are timing
 * sensitive (debounced persistence write, live CM6 mirroring) — run them
 * with `--repeat-each=3` to prove non-flake (no-flaky-tests memory).
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

// ─── Selector contract ────────────────────────────────────────────────────────

const SELECTORS = {
  leafPane: '[data-testid="leaf-pane"]',
  tabStrip: '[data-testid="tab-strip"]', // scoped within a leaf, per WS-03
  activePane: '[data-active-pane="true"]',
  paneDivider: '[data-testid="pane-divider"]',
} as const;

// ─── Shared helpers (mirrors phase15-uat.spec.ts's isolation pattern) ────────

/**
 * Spawn a binary with an isolated JASPER_APP_HOME so GET /vault/current returns
 * THIS test's ephemeral vault — not whatever vault a parallel worker last
 * opened in the shared default app home. The vault path is the localStorage
 * layout-persistence key (WS-08), so without isolation the reload/persistence
 * key would be non-deterministic across workers. Returns the handle + the
 * appHome to clean up.
 */
async function spawnIsolated(): Promise<{ jasper: JasperHandle; appHome: string }> {
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-p25-apphome-"));
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

function noteRow(page: Page, id: string): Locator {
  return page.locator(`[data-tree-row="${id}"][data-tree-row-kind="note"]`);
}

/** Open a tree note by clicking its row; waits for the row to be visible first. */
async function openNoteFromTree(page: Page, id: string): Promise<void> {
  const row = noteRow(page, id);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
}

/** All leaf panes currently rendered, in tree order (a before b, per paneTree.ts). */
function leafPanes(page: Page): Locator {
  return page.locator(SELECTORS.leafPane);
}

/** The tab strip scoped to a specific leaf pane. */
function tabStripFor(leaf: Locator): Locator {
  return leaf.locator(SELECTORS.tabStrip);
}

/** The tab pills (role="tab") scoped to a specific leaf pane's own strip. */
function tabPillsFor(leaf: Locator): Locator {
  return tabStripFor(leaf).getByRole("tab");
}

/**
 * Makes `leaf` the active pane (D-04: click anywhere in a leaf's chrome
 * focuses it, via LeafPane's onClickCapture). Clicking the CM6 host shell
 * both activates the pane and focuses its editor, which is convenient for
 * the shared-buffer scenario's subsequent typing.
 */
async function activatePane(leaf: Locator): Promise<void> {
  await leaf.getByTestId("cm-host-shell").click();
}

/**
 * Opens the command palette (Cmd+P, mode="commands") and activates the
 * command whose label matches `label` exactly. See the file header for why
 * this is used instead of the raw split/focus-cycle keyboard shortcuts.
 */
async function runCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Meta+p");
  const input = page.getByPlaceholder("Type a command…");
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(label);
  const row = page.locator('[data-row-kind="cmd"]').filter({ hasText: label }).first();
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.click();
}

// ─── WS-03 — independent tab strips per pane ─────────────────────────────────

test.describe("@phase25 WS-03: independent tab strips", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("each pane has independent tab strips — WS-03", async ({ page }) => {
    // A realistic laptop viewport (matches phase18/21/22/23-uat.spec.ts's
    // convention) — the default 1280x720 Desktop Chrome viewport is narrow
    // enough that 2 tabs in a HALF-width split leaf can trip TabStrip's
    // overflow dropdown (TAB-07), which is real overflow behavior but not
    // what these pane-independence assertions are testing.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "ws03-alpha");
    const idB = await apiCreateNote(page, jasper.baseURL, "ws03-beta");
    const idC = await apiCreateNote(page, jasper.baseURL, "ws03-gamma");

    await openNoteFromTree(page, idA);
    await expect(leafPanes(page)).toHaveCount(1);
    await expect(tabPillsFor(leafPanes(page).nth(0))).toHaveCount(1);

    // Split right (D-14/D-15): clones the active note into a new sibling
    // leaf, which becomes the active pane.
    await runCommand(page, "Split right");
    await expect(leafPanes(page)).toHaveCount(2);

    const leftLeaf = leafPanes(page).nth(0);
    const rightLeaf = leafPanes(page).nth(1);

    // Opening note B routes to the active pane (rightLeaf) — leftLeaf is
    // untouched, proving the two strips are independent, not shared state.
    await openNoteFromTree(page, idB);
    await expect(tabPillsFor(rightLeaf)).toHaveCount(2);
    await expect(tabPillsFor(leftLeaf)).toHaveCount(1);

    // Each leaf's active tab is independent.
    await expect(
      tabPillsFor(leftLeaf).filter({ hasText: "ws03-alpha" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      tabPillsFor(rightLeaf).filter({ hasText: "ws03-beta" }),
    ).toHaveAttribute("aria-selected", "true");

    // Each leaf's breadcrumb reflects its OWN active tab's note, independent
    // of the other leaf. Scoped to :visible — LeafPane keep-alive mounts an
    // EditorPane (and its own breadcrumb) per open tab, hidden via
    // display:none for every tab but the active one (D-01 keep-alive).
    await expect(
      leftLeaf
        .locator('[data-testid="note-breadcrumb"]:visible')
        .getByTestId("breadcrumb-segment"),
    ).toHaveText(["ws03-alpha"]);
    await expect(
      rightLeaf
        .locator('[data-testid="note-breadcrumb"]:visible')
        .getByTestId("breadcrumb-segment"),
    ).toHaveText(["ws03-beta"]);

    // Re-activate the left leaf (D-04 click-to-focus) and open a third note
    // there — it must NOT add a pill to the right leaf's strip.
    await activatePane(leftLeaf);
    await expect(leftLeaf).toHaveAttribute("data-active-pane", "true");
    await openNoteFromTree(page, idC);
    await expect(tabPillsFor(leftLeaf)).toHaveCount(2);
    await expect(tabPillsFor(rightLeaf)).toHaveCount(2);
    await expect(
      tabPillsFor(rightLeaf).filter({ hasText: "ws03-gamma" }),
    ).toHaveCount(0);
  });
});

// ─── WS-03 (UAT-4) — each pane renders its OWN metadata bar, even when inactive ──
//
// Locks the round-4 fix: the breadcrumb + word-count row is sourced from each
// pane's own note controller (getNotePath, seeded by that pane's getNote load)
// rather than the per-pane useFileTree() fetch, so it appears atomically with
// the note content and is present regardless of which pane is active. Before
// the fix, an inactive/freshly-split pane could render its note body while its
// metadata bar was still absent (the reported bug).

test.describe("@phase25 WS-03 UAT-4: per-pane metadata bar", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("both panes show their own breadcrumb + word-count, including the inactive one — WS-03/UAT-4", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "meta-alpha");
    const idB = await apiCreateNote(page, jasper.baseURL, "meta-beta");

    await openNoteFromTree(page, idA);
    await runCommand(page, "Split right");
    await expect(leafPanes(page)).toHaveCount(2);

    const leftLeaf = leafPanes(page).nth(0);
    const rightLeaf = leafPanes(page).nth(1);

    // Right pane (active after the split) opens note B.
    await openNoteFromTree(page, idB);
    await expect(
      tabPillsFor(rightLeaf).filter({ hasText: "meta-beta" }),
    ).toHaveAttribute("aria-selected", "true");

    // Make the LEFT pane active so the RIGHT pane is now INACTIVE — this is the
    // exact state where the metadata bar previously went missing.
    await activatePane(leftLeaf);
    await expect(leftLeaf).toHaveAttribute("data-active-pane", "true");
    await expect(rightLeaf).toHaveAttribute("data-active-pane", "false");

    // The INACTIVE right pane must still show its OWN breadcrumb + word-count.
    await expect(
      rightLeaf.locator('[data-testid="note-breadcrumb"]:visible'),
    ).toBeVisible();
    await expect(
      rightLeaf
        .locator('[data-testid="note-breadcrumb"]:visible')
        .getByTestId("breadcrumb-segment"),
    ).toHaveText(["meta-beta"]);
    await expect(
      rightLeaf.locator('[data-testid="word-count"]:visible'),
    ).toHaveCount(1);

    // The active left pane shows its own metadata bar too (its OWN note).
    await expect(
      leftLeaf
        .locator('[data-testid="note-breadcrumb"]:visible')
        .getByTestId("breadcrumb-segment"),
    ).toHaveText(["meta-alpha"]);
    await expect(
      leftLeaf.locator('[data-testid="word-count"]:visible'),
    ).toHaveCount(1);
  });
});

// ─── WS-04 — last-tab-close collapses pane + rebalances tree ────────────────

test.describe("@phase25 WS-04: collapse and rebalance", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("closing the last tab in a pane collapses and rebalances the tree — WS-04", async ({
    page,
  }) => {
    // A realistic laptop viewport (matches phase18/21/22/23-uat.spec.ts's
    // convention) — the default 1280x720 Desktop Chrome viewport is narrow
    // enough that 2 tabs in a HALF-width split leaf can trip TabStrip's
    // overflow dropdown (TAB-07), which is real overflow behavior but not
    // what these pane-independence assertions are testing.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "ws04-alpha");
    await openNoteFromTree(page, idA);
    await expect(leafPanes(page)).toHaveCount(1);

    await runCommand(page, "Split right");
    await expect(leafPanes(page)).toHaveCount(2);
    await expect(page.locator(SELECTORS.paneDivider)).toBeVisible();

    const leftLeaf = leafPanes(page).nth(0);
    const rightLeaf = leafPanes(page).nth(1);
    await expect(tabPillsFor(leftLeaf)).toHaveCount(1);
    await expect(tabPillsFor(rightLeaf)).toHaveCount(1); // clone of A (D-15)

    // Close the last remaining tab in the right-hand leaf.
    await tabPillsFor(rightLeaf)
      .first()
      .locator('button[aria-label^="Close"]')
      .click();

    // Collapse: one leaf remains, divider is gone, and the surviving leaf's
    // tab strip is unchanged (D-09 rebalance).
    await expect(leafPanes(page)).toHaveCount(1);
    await expect(page.locator(SELECTORS.paneDivider)).toHaveCount(0);
    const survivor = leafPanes(page).nth(0);
    await expect(tabPillsFor(survivor)).toHaveCount(1);
    await expect(
      tabPillsFor(survivor).filter({ hasText: "ws04-alpha" }),
    ).toHaveAttribute("aria-selected", "true");

    // Single-pane parity (D-10): with ONE pane left, closing its last tab
    // shows the "no note open" placeholder and the pane does NOT collapse.
    await tabPillsFor(survivor)
      .first()
      .locator('button[aria-label^="Close"]')
      .click();
    await expect(leafPanes(page)).toHaveCount(1);
    await expect(survivor.getByTestId("editor-pane-placeholder")).toBeVisible();
  });
});

// ─── WS-07/WS-08 — active-pane tracking + layout persistence across reload ──

test.describe("@phase25 WS-07/WS-08: active pane tracking and reload restore", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("active pane tracking persists across reload — WS-07/WS-08", async ({ page }) => {
    // A realistic laptop viewport (matches phase18/21/22/23-uat.spec.ts's
    // convention) — the default 1280x720 Desktop Chrome viewport is narrow
    // enough that 2 tabs in a HALF-width split leaf can trip TabStrip's
    // overflow dropdown (TAB-07), which is real overflow behavior but not
    // what these pane-independence assertions are testing.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "ws0708-alpha");
    const idB = await apiCreateNote(page, jasper.baseURL, "ws0708-beta");
    const idC = await apiCreateNote(page, jasper.baseURL, "ws0708-gamma");

    await openNoteFromTree(page, idA);
    await runCommand(page, "Split right");
    await expect(leafPanes(page)).toHaveCount(2);

    const leftLeaf = leafPanes(page).nth(0);
    const rightLeaf = leafPanes(page).nth(1);

    // rightLeaf is the active pane (new sibling) — note B routes there.
    await openNoteFromTree(page, idB);
    await expect(
      tabPillsFor(rightLeaf).filter({ hasText: "ws0708-beta" }),
    ).toHaveAttribute("aria-selected", "true");

    // Clicking the left leaf moves the active-pane marker (WS-07).
    await activatePane(leftLeaf);
    await expect(leftLeaf).toHaveAttribute("data-active-pane", "true");
    await expect(rightLeaf).toHaveAttribute("data-active-pane", "false");

    // The keyboard focus-cycle shortcut (D-08) moves the active pane.
    await runCommand(page, "Focus next pane");
    await expect(rightLeaf).toHaveAttribute("data-active-pane", "true");
    await expect(leftLeaf).toHaveAttribute("data-active-pane", "false");

    // A tree-open action targets the ACTIVE pane (rightLeaf), not leftLeaf.
    await openNoteFromTree(page, idC);
    await expect(tabPillsFor(rightLeaf)).toHaveCount(3);
    await expect(tabPillsFor(leftLeaf)).toHaveCount(1);
    // Singleton retargeting (D-07): the tree's active-row marker follows the
    // active pane's active tab.
    await expect(noteRow(page, idC)).toHaveAttribute("data-active", "true");

    // Persistence is debounced (~250ms) — poll localStorage until the full
    // layout (all three note ids) is written before reloading.
    await expect
      .poll(
        () =>
          page.evaluate(([a, b, c]) => {
            const key = Object.keys(localStorage).find((k) =>
              k.startsWith("jasper.layout."),
            );
            if (key === undefined) return false;
            const raw = localStorage.getItem(key) ?? "";
            return raw.includes(a) && raw.includes(b) && raw.includes(c);
          }, [idA, idB, idC]),
        { timeout: 5_000 },
      )
      .toBe(true);

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Full layout restored: two panes, each leaf's tab count, and the active
    // pane (WS-08).
    await expect(leafPanes(page)).toHaveCount(2, { timeout: 10_000 });
    const restoredLeft = leafPanes(page).nth(0);
    const restoredRight = leafPanes(page).nth(1);
    await expect(tabPillsFor(restoredLeft)).toHaveCount(1, { timeout: 10_000 });
    await expect(tabPillsFor(restoredRight)).toHaveCount(3, { timeout: 10_000 });
    await expect(restoredRight).toHaveAttribute("data-active-pane", "true", {
      timeout: 10_000,
    });
    await expect(restoredLeft).toHaveAttribute("data-active-pane", "false");

    // RightRail/StatusBar singletons retarget to the reloaded active pane's
    // active note (D-07): note C's tree row is the marked-active row.
    await expect(noteRow(page, idC)).toHaveAttribute("data-active", "true", {
      timeout: 10_000,
    });
  });
});

// ─── WS-10 — same note in two panes shares one live document ───────────────

test.describe("@phase25 WS-10: shared buffer across panes", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("the same note open in two panes shares one live document (shared buffer) — WS-10", async ({
    page,
  }) => {
    // A realistic laptop viewport (matches phase18/21/22/23-uat.spec.ts's
    // convention) — the default 1280x720 Desktop Chrome viewport is narrow
    // enough that 2 tabs in a HALF-width split leaf can trip TabStrip's
    // overflow dropdown (TAB-07), which is real overflow behavior but not
    // what these pane-independence assertions are testing.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "ws10-shared");
    await openNoteFromTree(page, idA);

    // Split right clones the active note into the new pane (D-15) — both
    // leaves show the SAME note from the start.
    await runCommand(page, "Split right");
    await expect(leafPanes(page)).toHaveCount(2);

    const leftLeaf = leafPanes(page).nth(0);
    const rightLeaf = leafPanes(page).nth(1);
    const leftEditor = leftLeaf.locator(".cm-content:visible");
    const rightEditor = rightLeaf.locator(".cm-content:visible");

    await expect(leftEditor).toBeVisible({ timeout: 8_000 });
    await expect(rightEditor).toBeVisible({ timeout: 8_000 });

    // Both panes start with the identical cloned document.
    const initialText = (await leftEditor.textContent()) ?? "";
    await expect
      .poll(async () => (await rightEditor.textContent()) ?? "")
      .toBe(initialText);

    // Typing in the left pane mirrors live into the right pane — no
    // save/reload round-trip (D-01: one shared per-note document).
    await leftEditor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" MIRROR-LEFT");
    await expect
      .poll(async () => (await rightEditor.textContent()) ?? "")
      .toContain("MIRROR-LEFT");

    // Mirroring is bidirectional; each pane keeps its OWN cursor/selection
    // on the shared document (D-02).
    await rightEditor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" MIRROR-RIGHT");
    await expect
      .poll(async () => (await leftEditor.textContent()) ?? "")
      .toContain("MIRROR-RIGHT");

    // Exactly ONE save-state machine drives the singleton SaveIndicator
    // (D-07) regardless of how many panes show the note — not one debounce
    // timer per pane racing another.
    await expect(page.locator("[data-save-state]")).toHaveCount(1);
    await expect
      .poll(
        async () =>
          await page.locator("[data-save-state]").getAttribute("data-save-state"),
        { timeout: 10_000 },
      )
      .toBe("saved");

    // No divergent conflict banner in either pane — a single shared buffer
    // means there is nothing to reconcile between panes.
    await expect(leftLeaf.getByTestId("conflict-banner")).toHaveCount(0);
    await expect(rightLeaf.getByTestId("conflict-banner")).toHaveCount(0);
  });
});
