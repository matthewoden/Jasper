/**
 * Phase 25 UAT — Split-Pane Foundation (WS-03/04/07/08/10).
 *
 * Wave-0 scaffold (25-01 Task 3): establishes the selector contract and four
 * `test.fixme` scenarios matching the ROADMAP.md success criteria for this
 * phase. Plan 09 un-fixmes and implements these bodies once the pane-tree
 * store, PaneTree renderer, and shared-doc registry land in later waves.
 *
 * Covers the end-to-end pane behaviors that will be observable in the browser:
 *   WS-03        each pane has its own independent tab strip, active tab, and
 *                breadcrumb — opening/switching a tab in one pane never
 *                affects another pane's tab strip.
 *   WS-04        closing the last tab in a leaf collapses that leaf; the
 *                sibling subtree fills the freed space (rebalance).
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
 * Discipline: ZERO fixed sleeps. Every timing-sensitive step (once implemented
 * in Plan 09) must use a web-first assertion (expect / expect.poll), mirroring
 * `phase15-uat.spec.ts`'s existing discipline.
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

/** All leaf panes currently rendered. */
function leafPanes(page: Page): Locator {
  return page.locator(SELECTORS.leafPane);
}

/** The tab strip scoped to a specific leaf pane. */
function tabStripFor(leaf: Locator): Locator {
  return leaf.locator(SELECTORS.tabStrip);
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

  test.fixme(
    "each pane has independent tab strips — WS-03",
    async ({ page }) => {
      // Intended assertions (Plan 09):
      // - Connect via waitForConnected(page, jasper.baseURL).
      // - Split the workspace (row split) into two leaf panes.
      // - Open note A's tab in the left leaf, note B's tab in the right leaf.
      // - Assert tabStripFor(leftLeaf) contains ONLY note A's pill, and
      //   tabStripFor(rightLeaf) contains ONLY note B's pill (scoped query,
      //   not a workspace-wide tab list).
      // - Assert each leaf's breadcrumb reflects its OWN active tab's note
      //   path, independently of the other leaf.
      // - Opening a third tab in the left leaf does not add a pill to the
      //   right leaf's tab strip (independent tab strips, not shared state).
      void page;
    },
  );
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

  test.fixme(
    "closing the last tab in a pane collapses and rebalances the tree — WS-04",
    async ({ page }) => {
      // Intended assertions (Plan 09):
      // - Split into two leaf panes, each with exactly one open tab.
      // - Assert leafPanes(page) has count 2 and [data-testid="pane-divider"]
      //   is visible.
      // - Close the last remaining tab in the right-hand leaf.
      // - Assert the collapse: leafPanes(page) now has count 1 (the divider
      //   is gone) and the surviving leaf's tab strip is unchanged.
      // - Single-pane parity: the surviving leaf behaves identically to the
      //   pre-Phase-25 single-editor-column app (breadcrumb, tab strip, etc).
      void page;
    },
  );
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

  test.fixme(
    "active pane tracking persists across reload — WS-07/WS-08",
    async ({ page }) => {
      // Intended assertions (Plan 09):
      // - Split into two leaf panes with distinct open notes.
      // - Click the right-hand leaf; assert it gains
      //   [data-active-pane="true"] and the left leaf loses it.
      // - A keyboard shortcut / palette action targets the ACTIVE pane (e.g.
      //   opening a note from the palette lands its tab in the right leaf,
      //   not the left).
      // - Reload the page (full navigation, not SPA route change).
      // - Assert the full layout — both leaf panes, their tabs, the active
      //   pane, and the split ratio — is restored: this is what makes the
      //   layout persist across reload rather than resetting to one pane.
      // - Assert RightRail/StatusBar singletons retarget to the reloaded
      //   active pane's active note, not the first pane.
      void page;
    },
  );
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

  test.fixme(
    "the same note open in two panes shares one live document (shared buffer) — WS-10",
    async ({ page }) => {
      // Intended assertions (Plan 09):
      // - Split into two leaf panes; open the SAME note in both (D-15 clone
      //   semantics — split clones the active pane's tab).
      // - Type text into the left pane's editor.
      // - Assert the right pane's editor reflects the SAME content (live
      //   mirror), without a save/reload round-trip.
      // - Assert cursor/selection/scroll remain INDEPENDENT per pane (only
      //   the document content is shared, per D-01/D-02).
      // - Assert there is exactly ONE save-state machine for the note: the
      //   save indicator in both panes transitions together (not two
      //   independent debounce timers racing each other).
      void page;
    },
  );
});

test("scaffold sanity — helpers compile and are referenced", () => {
  // This non-fixme test exists purely so the helper functions above are
  // exercised (not dead code) until Plan 09 wires them into real assertions.
  const noop = (_page: Page): Locator => leafPanes(_page);
  expect(typeof noop).toBe("function");
  expect(typeof tabStripFor).toBe("function");
  expect(typeof waitForConnected).toBe("function");
});
