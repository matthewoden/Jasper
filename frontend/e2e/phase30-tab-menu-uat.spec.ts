/**
 * Right-Rail Tags & Context Menus: tab context menu
 * (CTX-01, WS-06 tab-split entry point, pin drag).
 *
 * fills in the Wave-0 scaffold:
 *   CTX-01  Tab menu adds Close all, Open in split, New note to the
 *           right, Pin/Unpin, Rename, Show in file manager (locked
 *           locked order); close-others/to-right/all skip pinned
 *           tabs.
 *   WS-06   "Open in split" opens the tab's note in a new right/row
 *           split.
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) before Playwright — the spec runs against the EMBEDDED binary.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive assertion uses
 * expect/expect.poll (memory no-flaky-tests). The pin-drag case is driven
 * with real page.mouse.move/down/up (never synthetic DragEvents — memory
 * verify-dnd-with-real-mouse) and tagged `@pin-drag` so it can be re-run
 * with --repeat-each=50 for a non-flake proof, mirroring
 * phase26-drag-uat.spec.ts's startDragToward pattern.
 *
 * All tests in this file share ONE spawned binary/vault (beforeAll/afterAll)
 * but each Playwright test gets its own fresh browser context (empty
 * client-side pane-layout state) — so tests only need distinct note titles
 * to avoid collisions, not per-test vault isolation.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected, apiCreateNote } from "./helpers/phase7Helpers";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

const SELECTORS = {
  leafPane: '[data-testid="leaf-pane"]',
  tabStrip: '[data-testid="tab-strip"]',
} as const;

function leafPanes(page: Page): Locator {
  return page.locator(SELECTORS.leafPane);
}

function tabStrip(page: Page): Locator {
  return page.getByTestId("tab-strip");
}

/** The tab pill (role="tab") whose visible label matches `title` exactly, scoped to a strip. */
function tabPillIn(strip: Locator, title: string): Locator {
  return strip.getByRole("tab").filter({ hasText: title });
}

function tabPill(page: Page, title: string): Locator {
  return tabPillIn(tabStrip(page), title);
}

/** Locator for a tab's pin glyph (replaces the close-× once pinned). */
function pinGlyphIn(strip: Locator, title: string): Locator {
  return tabPillIn(strip, title).getByRole("button", {
    name: "Pinned tab — right-click to unpin",
  });
}

const LOCKED_ORDER = [
  "Close",
  "Close others",
  "Close to the right",
  "Close all",
  "Open in split",
  "New note to the right",
  "Pin tab",
  "Rename",
  "Show in file manager",
];

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
 * Drives a real page.mouse drag from (fromX, fromY) to (toX, toY) and
 * releases — multiple intermediate moves ensure enough pointermove events
 * fire to cross TabStrip's 5px DRAG_THRESHOLD (never synthetic DragEvents,
 * per project memory verify-dnd-with-real-mouse).
 */
async function dragAndDrop(
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
  await page.mouse.up();
}

async function openNoteAsTab(
  page: Page,
  baseURL: string,
  title: string,
): Promise<string> {
  const noteId = await apiCreateNote(
    page,
    baseURL,
    `${title}.md`,
    "",
    `# ${title}\n\nBody text for the earlier tab-menu UAT.\n`,
  );
  await openNoteFromTree(page, noteId);
  return noteId;
}

test.describe("@tab-menu: tab context menu", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("right-clicking a tab shows the locked CTX-01 item set in order", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const title = "tab-menu-items";
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteAsTab(page, jasper.baseURL, title);

    await tabPill(page, title).click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 5_000 });
    const items = menu.getByRole("menuitem");
    await expect(items).toHaveCount(LOCKED_ORDER.length);
    await expect(items).toHaveText(LOCKED_ORDER);
  });

  test("'Open in split' opens the tab's note in a new right/row split (WS-06)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const title = "tab-menu-split";
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteAsTab(page, jasper.baseURL, title);

    await expect(leafPanes(page)).toHaveCount(1);

    await tabPill(page, title).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open in split" }).click();

    // openNoteInNewSplit opens the note as a NEW tab in a new sibling leaf —
    // it does not move the original tab out of the source leaf — so the
    // title now appears once per leaf (2 total), and the new sibling becomes
    // the active pane.
    await expect(leafPanes(page)).toHaveCount(2, { timeout: 5_000 });
    await expect(
      page.locator(SELECTORS.tabStrip).getByRole("tab").filter({ hasText: title }),
    ).toHaveCount(2);
    await expect(
      page
        .locator('[data-testid="leaf-pane"][data-active-pane="true"]')
        .getByTestId("editor-title-element")
        .and(page.locator(":visible")),
    ).toHaveText(title, { timeout: 5_000 });
  });

  test("'Pin tab' pins the tab: glyph replaces the ×, Close others/Close all skip it, a direct glyph click refuses with a toast", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const pinnedTitle = "tab-menu-pin-target";
    const otherTitle1 = "tab-menu-pin-other-1";
    const otherTitle2 = "tab-menu-pin-other-2";
    await openNoteAsTab(page, jasper.baseURL, pinnedTitle);
    await openNoteAsTab(page, jasper.baseURL, otherTitle1);

    const strip = tabStrip(page);
    await expect(strip.getByRole("tab")).toHaveCount(2);

    // Pin the first tab via its context menu.
    await tabPillIn(strip, pinnedTitle).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin tab" }).click();

    // Pin glyph replaces the close-× for the pinned tab.
    await expect(pinGlyphIn(strip, pinnedTitle)).toBeVisible({ timeout: 5_000 });

    // "Close others" (invoked from the pinned tab's own menu — its own item
    // list still has "Close others" available) leaves the pinned tab open
    // and closes the unpinned one.
    await tabPillIn(strip, pinnedTitle).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close others" }).click();
    await expect(strip.getByRole("tab")).toHaveCount(1);
    await expect(tabPillIn(strip, pinnedTitle)).toHaveCount(1);

    // Open a fresh unpinned tab (distinct title — the first one's underlying
    // note file still exists on disk, just its tab closed), then prove
    // "Close all" also skips the pin.
    await openNoteAsTab(page, jasper.baseURL, otherTitle2);
    await expect(strip.getByRole("tab")).toHaveCount(2);
    await tabPillIn(strip, otherTitle2).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close all" }).click();
    await expect(strip.getByRole("tab")).toHaveCount(1);
    await expect(tabPillIn(strip, pinnedTitle)).toHaveCount(1);

    // Direct click on the pin glyph refuses the close with a toast.
    await pinGlyphIn(strip, pinnedTitle).click();
    await expect(
      page.getByText("This tab is pinned — right-click to unpin"),
    ).toBeVisible({ timeout: 5_000 });
    await expect(tabPillIn(strip, pinnedTitle)).toHaveCount(1);
  });

  test("@pin-drag pinned tabs group left; an unpinned tab dragged toward the front clamps to just after the pinned boundary (real-mouse)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const pTitle = "tab-menu-drag-p";
    const aTitle = "tab-menu-drag-a";
    const bTitle = "tab-menu-drag-b";
    await openNoteAsTab(page, jasper.baseURL, pTitle);
    await openNoteAsTab(page, jasper.baseURL, aTitle);
    await openNoteAsTab(page, jasper.baseURL, bTitle);

    const strip = tabStrip(page);
    await expect(strip.getByRole("tab")).toHaveCount(3);

    // Pin "p" — it is already first, so pinning does not reorder here; it
    // establishes the pinned boundary at index 1.
    await tabPillIn(strip, pTitle).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin tab" }).click();
    await expect(pinGlyphIn(strip, pTitle)).toBeVisible({ timeout: 5_000 });

    const pillP = tabPillIn(strip, pTitle);
    const pillB = tabPillIn(strip, bTitle);
    const pBox = await stableBox(pillP);
    const bBox = await stableBox(pillB);

    // Drag "b" (last, unpinned) all the way to BEFORE "p" (the pinned tab) —
    // without the boundary clamp this would land "b" at index 0,
    // ahead of the pinned tab. The clamp must hold it to index 1 (right
    // after "p"), landing the final order as [p, b, a].
    const fromX = bBox.x + bBox.width / 2;
    const fromY = bBox.y + bBox.height / 2;
    const toX = pBox.x + 2;
    const toY = pBox.y + pBox.height / 2;

    await dragAndDrop(page, fromX, fromY, toX, toY);

    await expect
      .poll(async () => {
        const titles = await strip.getByRole("tab").allTextContents();
        return titles.map((t) => t.trim());
      })
      .toEqual([pTitle, bTitle, aTitle]);

    // The pinned tab never lost its pin/position through the drag.
    await expect(pinGlyphIn(strip, pTitle)).toBeVisible();
  });
});
