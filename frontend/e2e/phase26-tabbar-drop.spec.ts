/**
 * Phase 26 polish UAT — Cross-pane tab-BAR positional insert (Obsidian
 * parity, P26 quick-task 260718-n6a).
 *
 * Dragging a tab onto a FOREIGN pane's tab STRIP (not its body) shows an
 * insertion caret at the hovered pill boundary and, on drop, inserts the
 * dragged tab at THAT index in the target leaf's tab order — not appended
 * to the end (the pre-existing dropTabOnPane "center" behavior). This is an
 * ADDITIONAL drop target alongside the untouched edge-band split (WS-01)
 * and center-body move (WS-02), covered by phase26-drag-uat.spec.ts.
 *
 * Every drag is driven with real `page.mouse.move/down/up` (multiple
 * intermediate moves so pointermove fires and crosses TabStrip's 5px
 * DRAG_THRESHOLD) against a freshly built binary — never synthetic
 * DragEvents, which false-pass in this codebase (verify-dnd-with-real-mouse
 * memory). Zero fixed sleeps; every timing-sensitive step uses a web-first
 * assertion.
 *
 * Selector contract (reuses the Phase 25/26 contract):
 *   - Leaf pane:               [data-testid="leaf-pane"]
 *   - Tab strip:                [data-testid="tab-strip"]
 *   - Foreign-strip caret:      [data-testid="tab-drop-indicator"]
 *   - Tab pill wrapper:         [data-tab-wrapper="<tabId>"]
 *
 * Same-pane in-strip reorder (drag pill 0 past pill 1 within ONE strip) is
 * NOT re-verified here — it is the untouched React-synthetic
 * handleStripPointerMove/Up path (CR-01), already covered exhaustively by
 * TabStrip.test.tsx and phase25-uat.spec.ts's own reorder scenarios.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

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

test.describe("@drag P26 polish: cross-pane tab-BAR positional insert (Obsidian parity)", () => {
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

    const idA = await apiCreateNote(page, jasper.baseURL, "tabbar-a-alpha");
    const idX = await apiCreateNote(page, jasper.baseURL, "tabbar-b-xray");
    const idY = await apiCreateNote(page, jasper.baseURL, "tabbar-b-yankee");

    // Pane A: alpha. Pane B (split right): xray, yankee (in that order).
    await openNoteFromTree(page, idA);
    await splitRight(page);
    await expect(leafPanes(page)).toHaveCount(2);
    const paneA = leafPanes(page).nth(0);
    const paneB = leafPanes(page).nth(1);

    await openNoteFromTree(page, idX);
    await openNoteFromTree(page, idY);
    await expect(tabPillsFor(paneA)).toHaveCount(1);
    await expect(tabPillsFor(paneB)).toHaveCount(2);
    await expect(tabPillsFor(paneB).nth(0)).toContainText("tabbar-b-xray");
    await expect(tabPillsFor(paneB).nth(1)).toContainText("tabbar-b-yankee");

    const alphaPill = tabPillsFor(paneA).filter({ hasText: "tabbar-a-alpha" });
    const pillBox = await stableBox(alphaPill);
    const xrayBox = await stableBox(tabPillsFor(paneB).nth(0));

    const fromX = pillBox.x + pillBox.width / 2;
    const fromY = pillBox.y + pillBox.height / 2;
    // Left QUARTER of xray's pill — well inside its left half, so the
    // midpoint test lands the caret BEFORE it (index 0).
    const toX = xrayBox.x + xrayBox.width * 0.15;
    const toY = xrayBox.y + xrayBox.height / 2;

    await startDragToward(page, fromX, fromY, toX, toY);

    const caret = tabStripFor(paneB).locator(SELECTORS.dropIndicator);
    await expect(caret).toBeVisible({ timeout: 3_000 });

    await page.screenshot({
      path: path.join(PARITY_SHOTS_DIR, "phase26-tabbar-drop.png"),
    });

    await page.mouse.up();

    // No new pane — this is a positional insert, not a split.
    await expect(leafPanes(page)).toHaveCount(2);
    await expect(tabPillsFor(paneA)).toHaveCount(0);
    await expect(tabPillsFor(paneB)).toHaveCount(3);

    const orderedTitles = await tabPillsFor(paneB).allTextContents();
    expect(orderedTitles[0]).toContain("tabbar-a-alpha");
    expect(orderedTitles[1]).toContain("tabbar-b-xray");
    expect(orderedTitles[2]).toContain("tabbar-b-yankee");
  });

  test("dropping BETWEEN pane B's two pills inserts the dragged tab at index 1", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "tabbar2-a-alpha");
    const idX = await apiCreateNote(page, jasper.baseURL, "tabbar2-b-xray");
    const idY = await apiCreateNote(page, jasper.baseURL, "tabbar2-b-yankee");

    await openNoteFromTree(page, idA);
    await splitRight(page);
    await expect(leafPanes(page)).toHaveCount(2);
    const paneA = leafPanes(page).nth(0);
    const paneB = leafPanes(page).nth(1);

    await openNoteFromTree(page, idX);
    await openNoteFromTree(page, idY);
    await expect(tabPillsFor(paneA)).toHaveCount(1);
    await expect(tabPillsFor(paneB)).toHaveCount(2);

    const alphaPill = tabPillsFor(paneA).filter({ hasText: "tabbar2-a-alpha" });
    const pillBox = await stableBox(alphaPill);
    const yankeeBox = await stableBox(tabPillsFor(paneB).nth(1));

    const fromX = pillBox.x + pillBox.width / 2;
    const fromY = pillBox.y + pillBox.height / 2;
    // Left quarter of yankee's pill (the SECOND pill) — lands the caret
    // between xray and yankee (index 1).
    const toX = yankeeBox.x + yankeeBox.width * 0.15;
    const toY = yankeeBox.y + yankeeBox.height / 2;

    await startDragToward(page, fromX, fromY, toX, toY);

    const caret = tabStripFor(paneB).locator(SELECTORS.dropIndicator);
    await expect(caret).toBeVisible({ timeout: 3_000 });

    await page.mouse.up();

    await expect(leafPanes(page)).toHaveCount(2);
    await expect(tabPillsFor(paneB)).toHaveCount(3);

    const orderedTitles = await tabPillsFor(paneB).allTextContents();
    expect(orderedTitles[0]).toContain("tabbar2-b-xray");
    expect(orderedTitles[1]).toContain("tabbar2-a-alpha");
    expect(orderedTitles[2]).toContain("tabbar2-b-yankee");
  });
});
