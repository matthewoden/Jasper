/**
 * Phase 26 UAT — Drag-to-Split-Pane (WS-01/WS-02, D-05..D-11).
 *
 * Every drag in this file is driven with real `page.mouse.move/down/up`
 * (multiple intermediate moves so pointermove fires and crosses TabStrip's
 * 5px DRAG_THRESHOLD) against a freshly built binary — never synthetic
 * DragEvents, which false-pass in this codebase (verify-dnd-with-real-mouse
 * memory). Zero fixed sleeps; every timing-sensitive step uses a web-first
 * assertion (expect / expect.poll), matching phase15/phase25-uat.spec.ts's
 * discipline.
 *
 * Scenarios (Task 3 acceptance criteria):
 *   1. Drag-to-split RIGHT (WS-01, D-05): overlay right half → release →
 *      leaf-pane count 1→2, dragged tab lands in the new right pane and is
 *      removed from the source.
 *   2. Drag-to-split BOTTOM: same but a col split (top/bottom).
 *   3. Drag-to-move CENTER (WS-02, D-08): overlay full-pane → release → NO
 *      new pane, tab relocates into the target pane's strip.
 *   4. Last-tab-out collapse (D-06): dragging a pane's only tab elsewhere
 *      collapses the now-empty source pane (leaf-pane count 2→1).
 *   5. Ghost floats across panes (D-11): the reused TabStrip ghost pill is
 *      visible mid-drag while the cursor is over a DIFFERENT pane's body.
 *
 * Selector contract (new in this plan, alongside the Phase 25 contract):
 *   - Drop-region overlay:   [data-testid="drop-overlay"][data-drop-region="…"]
 *   - Cross-pane drag ghost: [data-testid="tab-drag-ghost"] (Phase 25, reused)
 *   - Droppane hit-test root: [data-droppane]
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const PARITY_SHOTS_DIR = path.join(repoRoot, ".parity-shots");

// ─── Selector contract ────────────────────────────────────────────────────────

const SELECTORS = {
  leafPane: '[data-testid="leaf-pane"]',
  tabStrip: '[data-testid="tab-strip"]',
  dropOverlay: '[data-testid="drop-overlay"]',
  dragGhost: '[data-testid="tab-drag-ghost"]',
} as const;

// ─── Shared helpers (mirrors phase25-uat.spec.ts's isolation pattern) ────────

async function spawnIsolated(): Promise<{ jasper: JasperHandle; appHome: string }> {
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-p26-drag-apphome-"));
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
async function apiCreateNote(page: Page, baseURL: string, title: string): Promise<string> {
  const resp = await page.request.post(`${baseURL}/api/v1/notes`, {
    data: { parent_path: "", title },
  });
  if (resp.status() !== 201) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`apiCreateNote ${title}: ${String(resp.status())} ${body}`);
  }
  return ((await resp.json()) as { id: string }).id;
}

/** All leaf panes currently rendered, in tree order (a before b, per paneTree.ts). */
function leafPanes(page: Page): Locator {
  return page.locator(SELECTORS.leafPane);
}

function tabStripFor(leaf: Locator): Locator {
  return leaf.locator(SELECTORS.tabStrip);
}

/** The tab pills (role="tab") scoped to a specific leaf pane's own strip. */
function tabPillsFor(leaf: Locator): Locator {
  return tabStripFor(leaf).getByRole("tab");
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Resolves a bounding box, polling until layout settles to non-zero dimensions. */
async function stableBox(locator: Locator): Promise<Box> {
  let box: Box | null = null;
  await expect
    .poll(
      async () => {
        box = await locator.boundingBox();
        return box !== null && box.width > 0 && box.height > 0;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  if (box === null) throw new Error("bounding box unavailable");
  return box;
}

/**
 * Drives a real page.mouse drag from a tab pill's center toward (toX, toY)
 * WITHOUT releasing — the caller asserts mid-drag state, then owns
 * page.mouse.up() itself. Multiple intermediate moves (a threshold-crossing
 * nudge, then several steps toward the target) ensure enough pointermove
 * events fire to cross TabStrip's 5px DRAG_THRESHOLD and let the window
 * pointermove hit-test settle on the final target (never synthetic
 * DragEvents — verify-dnd-with-real-mouse memory).
 */
async function startDragToward(
  page: Page,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Promise<void> {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX + 10, fromY, { steps: 3 });
  await page.mouse.move(toX, toY, { steps: 15 });
}

test.describe("@drag WS-01/WS-02: drag-to-split / drag-to-move", () => {
  let jasper: JasperHandle;
  let appHome: string;

  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
    fs.mkdirSync(PARITY_SHOTS_DIR, { recursive: true });
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("drag a tab to the RIGHT edge-band splits the pane and MOVES the tab (WS-01, D-05)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "drag-right-alpha");
    const idB = await apiCreateNote(page, jasper.baseURL, "drag-right-beta");
    const idC = await apiCreateNote(page, jasper.baseURL, "drag-right-gamma");
    void idC;

    await openNoteFromTree(page, idA);
    await openNoteFromTree(page, idB);
    await expect(leafPanes(page)).toHaveCount(1);
    const soloLeaf = leafPanes(page).nth(0);
    await expect(tabPillsFor(soloLeaf)).toHaveCount(2);

    const leafBox = await stableBox(soloLeaf);
    const alphaPill = tabPillsFor(soloLeaf).filter({ hasText: "drag-right-alpha" });
    const pillBox = await stableBox(alphaPill);

    const fromX = pillBox.x + pillBox.width / 2;
    const fromY = pillBox.y + pillBox.height / 2;
    // px > 0.78 fraction of the pane rect → right edge band (UI-SPEC).
    const toX = leafBox.x + leafBox.width * 0.92;
    const toY = leafBox.y + leafBox.height * 0.5;

    await startDragToward(page, fromX, fromY, toX, toY);

    const overlay = page.locator(SELECTORS.dropOverlay);
    await expect(overlay).toBeVisible({ timeout: 3_000 });
    await expect(overlay).toHaveAttribute("data-drop-region", "right");
    const overlayBox = await stableBox(overlay);
    // Split overlay covers roughly HALF the pane (UI-SPEC: width 50%).
    expect(overlayBox.width).toBeGreaterThan(leafBox.width * 0.35);
    expect(overlayBox.width).toBeLessThan(leafBox.width * 0.65);

    await page.screenshot({
      path: path.join(PARITY_SHOTS_DIR, "phase26-drag-overlay.png"),
    });

    await page.mouse.up();

    await expect(leafPanes(page)).toHaveCount(2);
    const leftLeaf = leafPanes(page).nth(0);
    const rightLeaf = leafPanes(page).nth(1);
    // splitWithTab region="right" → placement "second" → the new sibling
    // (holding the dragged tab) is `b`, rendered second (right).
    await expect(
      tabPillsFor(rightLeaf).filter({ hasText: "drag-right-alpha" }),
    ).toHaveCount(1);
    await expect(
      tabPillsFor(leftLeaf).filter({ hasText: "drag-right-alpha" }),
    ).toHaveCount(0);
    await expect(
      tabPillsFor(leftLeaf).filter({ hasText: "drag-right-beta" }),
    ).toHaveCount(1);
  });

  test("drag a tab to the BOTTOM edge-band splits the pane into a column layout (WS-01, D-05)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "drag-bottom-alpha");
    const idB = await apiCreateNote(page, jasper.baseURL, "drag-bottom-beta");

    await openNoteFromTree(page, idA);
    await openNoteFromTree(page, idB);
    await expect(leafPanes(page)).toHaveCount(1);
    const soloLeaf = leafPanes(page).nth(0);
    await expect(tabPillsFor(soloLeaf)).toHaveCount(2);

    const leafBox = await stableBox(soloLeaf);
    const alphaPill = tabPillsFor(soloLeaf).filter({ hasText: "drag-bottom-alpha" });
    const pillBox = await stableBox(alphaPill);

    const fromX = pillBox.x + pillBox.width / 2;
    const fromY = pillBox.y + pillBox.height / 2;
    // py > 0.78 fraction of the pane rect → bottom edge band (UI-SPEC).
    const toX = leafBox.x + leafBox.width * 0.5;
    const toY = leafBox.y + leafBox.height * 0.92;

    await startDragToward(page, fromX, fromY, toX, toY);

    const overlay = page.locator(SELECTORS.dropOverlay);
    await expect(overlay).toBeVisible({ timeout: 3_000 });
    await expect(overlay).toHaveAttribute("data-drop-region", "bottom");

    await page.mouse.up();

    await expect(leafPanes(page)).toHaveCount(2);
    const topLeaf = leafPanes(page).nth(0);
    const bottomLeaf = leafPanes(page).nth(1);
    // region="bottom" → dir col, placement "second" → new sibling (moved
    // tab) is `b`, rendered second (bottom).
    await expect(
      tabPillsFor(bottomLeaf).filter({ hasText: "drag-bottom-alpha" }),
    ).toHaveCount(1);
    await expect(
      tabPillsFor(topLeaf).filter({ hasText: "drag-bottom-alpha" }),
    ).toHaveCount(0);
    await expect(
      tabPillsFor(topLeaf).filter({ hasText: "drag-bottom-beta" }),
    ).toHaveCount(1);

    // Stacked (column) layout: the second pane sits BELOW the first, not
    // beside it.
    const topBox = await stableBox(topLeaf);
    const bottomBox = await stableBox(bottomLeaf);
    expect(bottomBox.y).toBeGreaterThan(topBox.y + topBox.height - 5);
  });

  test("drag a tab to another pane's CENTER moves it without splitting (WS-02, D-08)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "drag-center-alpha");
    const idB = await apiCreateNote(page, jasper.baseURL, "drag-center-beta");
    const idC = await apiCreateNote(page, jasper.baseURL, "drag-center-gamma");

    await openNoteFromTree(page, idA);
    await openNoteFromTree(page, idB);
    // Split so there are two panes: left keeps alpha+beta, right gets a
    // clone of the active tab (beta) via the existing splitActivePane path.
    await page.keyboard.press("Meta+p");
    const cmdInput = page.getByPlaceholder("Type a command…");
    await expect(cmdInput).toBeVisible({ timeout: 5_000 });
    await cmdInput.fill("Split right");
    const splitRow = page.locator('[data-row-kind="cmd"]').filter({ hasText: "Split right" }).first();
    await expect(splitRow).toBeVisible({ timeout: 5_000 });
    await splitRow.click();
    await expect(leafPanes(page)).toHaveCount(2);

    const leftLeaf = leafPanes(page).nth(0);
    const rightLeaf = leafPanes(page).nth(1);

    // Open gamma in the (active, right) pane so left keeps [alpha, beta] and
    // right keeps [beta-clone, gamma] — a distinct tab to drag from left.
    await openNoteFromTree(page, idC);
    await expect(tabPillsFor(leftLeaf)).toHaveCount(2);
    await expect(tabPillsFor(rightLeaf)).toHaveCount(2);

    const rightBox = await stableBox(rightLeaf);
    const alphaPill = tabPillsFor(leftLeaf).filter({ hasText: "drag-center-alpha" });
    const pillBox = await stableBox(alphaPill);

    const fromX = pillBox.x + pillBox.width / 2;
    const fromY = pillBox.y + pillBox.height / 2;
    // Dead center of the target pane's full rect — well inside the ~56%
    // center zone (px/py both 0.5, comfortably between 0.22 and 0.78).
    const toX = rightBox.x + rightBox.width * 0.5;
    const toY = rightBox.y + rightBox.height * 0.5;

    await startDragToward(page, fromX, fromY, toX, toY);

    const overlay = page.locator(SELECTORS.dropOverlay);
    await expect(overlay).toBeVisible({ timeout: 3_000 });
    await expect(overlay).toHaveAttribute("data-drop-region", "center");
    const overlayBox = await stableBox(overlay);
    // Center overlay is `inset:0` on the editor BODY container (below the tab
    // strip, per LeafPane's own DOM structure) — full WIDTH of the pane, but
    // its HEIGHT is the pane height minus the ~40px tab strip, not the full
    // leaf-pane rect height.
    expect(Math.abs(overlayBox.width - rightBox.width)).toBeLessThan(2);
    expect(overlayBox.height).toBeGreaterThan(rightBox.height * 0.8);

    await page.mouse.up();

    // No new pane created.
    await expect(leafPanes(page)).toHaveCount(2);
    await expect(
      tabPillsFor(rightLeaf).filter({ hasText: "drag-center-alpha" }),
    ).toHaveCount(1);
    await expect(
      tabPillsFor(leftLeaf).filter({ hasText: "drag-center-alpha" }),
    ).toHaveCount(0);
    await expect(tabPillsFor(leftLeaf)).toHaveCount(1);
    await expect(tabPillsFor(rightLeaf)).toHaveCount(3);
  });

  test("dragging a pane's last tab elsewhere collapses the source pane (D-06)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "collapse-alpha");
    const idB = await apiCreateNote(page, jasper.baseURL, "collapse-beta");

    await openNoteFromTree(page, idA);
    await page.keyboard.press("Meta+p");
    const cmdInput = page.getByPlaceholder("Type a command…");
    await expect(cmdInput).toBeVisible({ timeout: 5_000 });
    await cmdInput.fill("Split right");
    const splitRow = page.locator('[data-row-kind="cmd"]').filter({ hasText: "Split right" }).first();
    await expect(splitRow).toBeVisible({ timeout: 5_000 });
    await splitRow.click();
    await expect(leafPanes(page)).toHaveCount(2);

    const leftLeaf = leafPanes(page).nth(0);
    const rightLeaf = leafPanes(page).nth(1);
    // Both panes hold exactly one tab (the clone) at this point.
    await expect(tabPillsFor(leftLeaf)).toHaveCount(1);
    await expect(tabPillsFor(rightLeaf)).toHaveCount(1);

    // Give the right pane a second, distinguishable note so we can tell it
    // apart from the (about to be dragged-away and collapsed) left pane.
    await openNoteFromTree(page, idB);
    await expect(tabPillsFor(rightLeaf)).toHaveCount(2);

    const rightBox = await stableBox(rightLeaf);
    const alphaPill = tabPillsFor(leftLeaf).filter({ hasText: "collapse-alpha" });
    const pillBox = await stableBox(alphaPill);

    const fromX = pillBox.x + pillBox.width / 2;
    const fromY = pillBox.y + pillBox.height / 2;
    const toX = rightBox.x + rightBox.width * 0.5;
    const toY = rightBox.y + rightBox.height * 0.5;

    await startDragToward(page, fromX, fromY, toX, toY);
    await expect(page.locator(SELECTORS.dropOverlay)).toBeVisible({ timeout: 3_000 });
    await page.mouse.up();

    // Source (left) pane emptied and collapsed — only one pane survives.
    await expect(leafPanes(page)).toHaveCount(1);
    const survivor = leafPanes(page).nth(0);
    await expect(tabPillsFor(survivor).filter({ hasText: "collapse-alpha" })).toHaveCount(1);
    await expect(tabPillsFor(survivor).filter({ hasText: "collapse-beta" })).toHaveCount(1);
  });

  test("the reused drag ghost is visible over a DIFFERENT pane's body mid-drag (D-11)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "ghost-alpha");
    const idB = await apiCreateNote(page, jasper.baseURL, "ghost-beta");

    await openNoteFromTree(page, idA);
    await page.keyboard.press("Meta+p");
    const cmdInput = page.getByPlaceholder("Type a command…");
    await expect(cmdInput).toBeVisible({ timeout: 5_000 });
    await cmdInput.fill("Split right");
    const splitRow = page.locator('[data-row-kind="cmd"]').filter({ hasText: "Split right" }).first();
    await expect(splitRow).toBeVisible({ timeout: 5_000 });
    await splitRow.click();
    await expect(leafPanes(page)).toHaveCount(2);

    const leftLeaf = leafPanes(page).nth(0);
    const rightLeaf = leafPanes(page).nth(1);
    await openNoteFromTree(page, idB);
    await expect(tabPillsFor(leftLeaf)).toHaveCount(1);
    await expect(tabPillsFor(rightLeaf)).toHaveCount(2);

    const rightBox = await stableBox(rightLeaf);
    const alphaPill = tabPillsFor(leftLeaf).filter({ hasText: "ghost-alpha" });
    const pillBox = await stableBox(alphaPill);

    const fromX = pillBox.x + pillBox.width / 2;
    const fromY = pillBox.y + pillBox.height / 2;
    // Land squarely inside the OTHER (right) pane's body — outside the
    // source strip entirely.
    const toX = rightBox.x + rightBox.width * 0.5;
    const toY = rightBox.y + rightBox.height * 0.5;

    await startDragToward(page, fromX, fromY, toX, toY);

    await expect(page.locator(SELECTORS.dragGhost)).toBeVisible({ timeout: 3_000 });
    // Confirm the ghost is genuinely over the OTHER pane, not the source strip.
    const ghostBox = await stableBox(page.locator(SELECTORS.dragGhost));
    expect(ghostBox.x).toBeGreaterThanOrEqual(rightBox.x - 5);

    await page.mouse.up();
    await expect(page.locator(SELECTORS.dragGhost)).toHaveCount(0, { timeout: 3_000 });
  });
});
