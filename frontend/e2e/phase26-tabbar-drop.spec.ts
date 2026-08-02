/**
 * Dropping a tab on a FOREIGN pane's tab STRIP inserts at the hovered pill
 * boundary rather than appending — an additional drop target alongside the
 * edge-band split and center-body move covered by phase26-drag-uat.spec.ts.
 *
 * Same-pane in-strip reorder is NOT re-verified here: it is the untouched
 * React-synthetic path, already covered by TabStrip.test.tsx and phase25-uat.
 *
 * Drags are real page.mouse with intermediate moves past the 5px threshold.
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
  dropIndicator: '[data-testid="tab-drop-indicator"]',
} as const;

// ─── Shared helpers (mirrors phase26-drag-uat.spec.ts's isolation pattern) ────

async function spawnIsolated(): Promise<{ jasper: JasperHandle; appHome: string }> {
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-p26-tabbar-apphome-"));
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

/** Splits the active pane right via the command palette (mirrors phase26-drag-uat.spec.ts). */
async function splitRight(page: Page): Promise<void> {
  await page.keyboard.press("Meta+p");
  const cmdInput = page.getByPlaceholder("Type a command…");
  await expect(cmdInput).toBeVisible({ timeout: 5_000 });
  await cmdInput.fill("Split right");
  const splitRow = page.locator('[data-row-kind="cmd"]').filter({ hasText: "Split right" }).first();
  await expect(splitRow).toBeVisible({ timeout: 5_000 });
  await splitRow.click();
}

test.describe("@drag cross-pane tab-BAR positional insert (Obsidian parity)", () => {
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

  test("dropping on the LEFT HALF of pane B's first pill inserts the dragged tab at index 0", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await waitForConnected(page, jasper.baseURL);

    const idAlpha = await apiCreateNote(page, jasper.baseURL, "tabbar-alpha");
    const idBeta = await apiCreateNote(page, jasper.baseURL, "tabbar-beta");
    const idXray = await apiCreateNote(page, jasper.baseURL, "tabbar-xray");

    // Pane A: alpha + beta. "Split right" CLONES the active tab (beta) into
    // pane B, so opening xray in B yields B = [beta, xray]. Dragging alpha
    // (only in A) into B is a clean positional insert: alpha is not already in
    // B (no dedup) and A keeps beta afterwards (no collapse).
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);
    await splitRight(page);
    await expect(leafPanes(page)).toHaveCount(2);
    const paneA = leafPanes(page).nth(0);
    const paneB = leafPanes(page).nth(1);

    await openNoteFromTree(page, idXray);
    await expect(tabPillsFor(paneA)).toHaveCount(2);
    await expect(tabPillsFor(paneB)).toHaveCount(2);
    await expect(tabPillsFor(paneB).nth(0)).toContainText("tabbar-beta");
    await expect(tabPillsFor(paneB).nth(1)).toContainText("tabbar-xray");

    const alphaPill = tabPillsFor(paneA).filter({ hasText: "tabbar-alpha" });
    const pillBox = await stableBox(alphaPill);
    const betaBoxB = await stableBox(tabPillsFor(paneB).nth(0));

    const fromX = pillBox.x + pillBox.width / 2;
    const fromY = pillBox.y + pillBox.height / 2;
    // Left QUARTER of pane B's FIRST pill (beta) — well inside its left half,
    // so the midpoint test lands the caret BEFORE it (index 0).
    const toX = betaBoxB.x + betaBoxB.width * 0.15;
    const toY = betaBoxB.y + betaBoxB.height / 2;

    await startDragToward(page, fromX, fromY, toX, toY);

    const caret = tabStripFor(paneB).locator(SELECTORS.dropIndicator);
    await expect(caret).toBeVisible({ timeout: 3_000 });

    await page.screenshot({
      path: path.join(PARITY_SHOTS_DIR, "phase26-tabbar-drop.png"),
    });

    await page.mouse.up();

    // No new pane — positional insert, not a split. A keeps beta (no collapse);
    // alpha lands at index 0 in B.
    await expect(leafPanes(page)).toHaveCount(2);
    await expect(tabPillsFor(paneA)).toHaveCount(1);
    await expect(tabPillsFor(paneA).nth(0)).toContainText("tabbar-beta");
    await expect(tabPillsFor(paneB)).toHaveCount(3);

    const orderedTitles = await tabPillsFor(paneB).allTextContents();
    expect(orderedTitles[0]).toContain("tabbar-alpha");
    expect(orderedTitles[1]).toContain("tabbar-beta");
    expect(orderedTitles[2]).toContain("tabbar-xray");
  });

  test("dropping BETWEEN pane B's two pills inserts the dragged tab at index 1", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await waitForConnected(page, jasper.baseURL);

    const idAlpha = await apiCreateNote(page, jasper.baseURL, "tabbar2-alpha");
    const idBeta = await apiCreateNote(page, jasper.baseURL, "tabbar2-beta");
    const idXray = await apiCreateNote(page, jasper.baseURL, "tabbar2-xray");

    // Same clean setup as the index-0 test: A = [alpha, beta]; split clones
    // beta into B; open xray in B → B = [beta, xray]. Drag alpha between B's
    // two pills to land it at index 1.
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);
    await splitRight(page);
    await expect(leafPanes(page)).toHaveCount(2);
    const paneA = leafPanes(page).nth(0);
    const paneB = leafPanes(page).nth(1);

    await openNoteFromTree(page, idXray);
    await expect(tabPillsFor(paneA)).toHaveCount(2);
    await expect(tabPillsFor(paneB)).toHaveCount(2);
    await expect(tabPillsFor(paneB).nth(0)).toContainText("tabbar2-beta");
    await expect(tabPillsFor(paneB).nth(1)).toContainText("tabbar2-xray");

    const alphaPill = tabPillsFor(paneA).filter({ hasText: "tabbar2-alpha" });
    const pillBox = await stableBox(alphaPill);
    const xrayBoxB = await stableBox(tabPillsFor(paneB).nth(1));

    const fromX = pillBox.x + pillBox.width / 2;
    const fromY = pillBox.y + pillBox.height / 2;
    // Left quarter of B's SECOND pill (xray) — lands the caret between beta
    // and xray (index 1).
    const toX = xrayBoxB.x + xrayBoxB.width * 0.15;
    const toY = xrayBoxB.y + xrayBoxB.height / 2;

    await startDragToward(page, fromX, fromY, toX, toY);

    const caret = tabStripFor(paneB).locator(SELECTORS.dropIndicator);
    await expect(caret).toBeVisible({ timeout: 3_000 });

    await page.mouse.up();

    await expect(leafPanes(page)).toHaveCount(2);
    await expect(tabPillsFor(paneA)).toHaveCount(1);
    await expect(tabPillsFor(paneB)).toHaveCount(3);

    const orderedTitles = await tabPillsFor(paneB).allTextContents();
    expect(orderedTitles[0]).toContain("tabbar2-beta");
    expect(orderedTitles[1]).toContain("tabbar2-alpha");
    expect(orderedTitles[2]).toContain("tabbar2-xray");
  });
});
