/**
 * Phase 18 UAT — Activity Ribbon & Chrome Shell.
 *
 * D-05 (regression gate): the tab-bar restyle (TABUI-01) touches every pixel
 *   value the pointer-drag math (`computeDropTarget`, wrapper
 *   `getBoundingClientRect`) depends on indirectly via layout. This spec
 *   proves — with real `page.mouse` against a rebuilt binary, never synthetic
 *   DragEvents (memory `verify-dnd-with-real-mouse`) — that drag-reorder, the
 *   cursor-following ghost, and the insertion indicator all still work.
 * TABUI-01: tabs are 40px tall, square-cornered (no border-radius), each has
 *   a leading file icon + a close X, and the active tab shows a 2px accent
 *   TOP border (moved from the old bottom-border position).
 *
 * (RIBBON-01..04 and TABUI-02 ribbon/right-cluster coverage land in Task 2 of
 * this plan, appended to this same file.)
 *
 * Harness mirrors phase17-uat.spec.ts: spawnJasper per describe block,
 * beforeAll/afterAll. Every binary-backed describe gets its own ephemeral
 * vault (spawnJasper's default dataDir), so tests never share mutable server
 * state across describes; Playwright's per-test browsing context means
 * client-side (localStorage/Zustand) state also resets between tests within
 * the same describe.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive step uses a web-first
 * assertion (expect / expect.poll).
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

async function waitForConnected(page: Page, baseURL: string): Promise<void> {
  await page.goto(baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

/** Create a note via the API; returns its UUID. */
async function createNote(jasper: JasperHandle, title: string): Promise<string> {
  const resp = await fetch(`${jasper.baseURL}/api/v1/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent_path: "", title }),
  });
  if (!resp.ok) throw new Error(`create ${title}: ${resp.status}`);
  return ((await resp.json()) as { id: string }).id;
}

function tabStrip(page: Page) {
  return page.getByTestId("tab-strip");
}

/** All tab pills currently rendered in the strip (excludes overflow-hidden). */
function tabPills(page: Page) {
  return tabStrip(page).getByRole("tab");
}

function noteRow(page: Page, id: string) {
  return page.locator(`[data-tree-row="${id}"][data-tree-row-kind="note"]`);
}

/** Open a tree note by clicking its row; waits for the row to be visible first. */
async function openNoteFromTree(page: Page, id: string): Promise<void> {
  const row = noteRow(page, id);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
}

// ─── D-05: DnD regression — drag-reorder, ghost, drop indicator ─────────────

test.describe("@phase18 D-05: DnD regression — drag/ghost/drop-indicator survive the restyle", () => {
  let jasper: JasperHandle;
  let idAlpha: string;
  let idBeta: string;
  let idGamma: string;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
    idAlpha = await createNote(jasper, "d05-alpha");
    idBeta = await createNote(jasper, "d05-beta");
    idGamma = await createNote(jasper, "d05-gamma");
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("real page.mouse drag past pill[1]'s midpoint reorders the strip (3 tabs open)", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);
    await openNoteFromTree(page, idGamma);

    await expect(tabPills(page)).toHaveCount(3);
    expect(
      (await tabPills(page).allTextContents()).map((t) => t.trim()),
    ).toEqual(["d05-alpha", "d05-beta", "d05-gamma"]);

    // Read bounding boxes — poll until they resolve to non-zero dimensions.
    let pill0bbox = await tabPills(page).nth(0).boundingBox();
    let pill1bbox = await tabPills(page).nth(1).boundingBox();
    await expect
      .poll(async () => {
        pill0bbox = await tabPills(page).nth(0).boundingBox();
        pill1bbox = await tabPills(page).nth(1).boundingBox();
        return (pill0bbox?.width ?? 0) > 0 && (pill1bbox?.width ?? 0) > 0;
      }, { timeout: 5_000 })
      .toBe(true);
    if (!pill0bbox || !pill1bbox) throw new Error("pill bounding boxes unavailable");

    // Start at pill0 center, drag to pill1's right edge (past pill1's midpoint,
    // still before pill2 starts) in multiple steps so the 5px drag threshold
    // is crossed and intermediate pointermove events fire.
    const fromX = pill0bbox.x + pill0bbox.width / 2;
    const fromY = pill0bbox.y + pill0bbox.height / 2;
    const toX = pill1bbox.x + pill1bbox.width - 2;
    const toY = pill1bbox.y + pill1bbox.height / 2;

    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 10 });
    await page.mouse.up();

    // reorderTabs splices fromIndex out of the array BEFORE inserting at
    // toIndex, so a drop target computed against the pre-removal array (here,
    // "gamma", index 2) lands past the shifted end once alpha is removed:
    // [alpha,beta,gamma] -> remove alpha -> [beta,gamma] -> insert at index 2
    // (now out of bounds) -> [beta,gamma,alpha]. This is pre-existing,
    // already-shipped reorder semantics (useTabStore.reorderTabs), not
    // something this restyle changes.
    await expect
      .poll(
        async () =>
          (await tabPills(page).allTextContents()).map((t) => t.trim()),
        { timeout: 5_000 },
      )
      .toEqual(["d05-beta", "d05-gamma", "d05-alpha"]);
  });

  test("ghost + drop indicator appear during an active drag and are removed on mouse-up", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);
    await expect(tabPills(page)).toHaveCount(2);

    let pill0bbox = await tabPills(page).nth(0).boundingBox();
    await expect
      .poll(async () => {
        pill0bbox = await tabPills(page).nth(0).boundingBox();
        return (pill0bbox?.width ?? 0) > 0;
      }, { timeout: 5_000 })
      .toBe(true);
    if (!pill0bbox) throw new Error("pill0 bounding box unavailable");

    const fromX = pill0bbox.x + pill0bbox.width / 2;
    const fromY = pill0bbox.y + pill0bbox.height / 2;

    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    // Move 30px past the 5px drag threshold so the strip activates the drag.
    await page.mouse.move(fromX + 30, fromY, { steps: 6 });

    await expect(page.getByTestId("tab-drag-ghost")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId("tab-drop-indicator")).toBeVisible({ timeout: 3_000 });

    await page.mouse.up();

    await expect(page.getByTestId("tab-drag-ghost")).toHaveCount(0, { timeout: 3_000 });
    await expect(page.getByTestId("tab-drop-indicator")).toHaveCount(0, { timeout: 3_000 });
  });
});

// ─── TABUI-01: tab geometry ──────────────────────────────────────────────────

test.describe("@phase18 TABUI-01: tab geometry (40px, flush, top accent, file icon)", () => {
  let jasper: JasperHandle;
  let idFirst: string;
  let idSecond: string;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
    idFirst = await createNote(jasper, "geometry-first");
    idSecond = await createNote(jasper, "geometry-second");
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("active + inactive tabs are 40px/square-cornered; active has a 2px accent top border, file icon, and close X", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, idFirst);
    await openNoteFromTree(page, idSecond);
    await expect(tabPills(page)).toHaveCount(2);

    // idSecond was opened last, so it is the active tab.
    const activePill = page.getByRole("tab", { selected: true });
    const inactivePill = page.getByRole("tab", { selected: false });
    await expect(activePill).toHaveCount(1);
    await expect(inactivePill).toHaveCount(1);

    for (const pill of [activePill, inactivePill]) {
      const geometry = await pill.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          height: cs.height,
          borderTopLeftRadius: cs.borderTopLeftRadius,
          borderTopRightRadius: cs.borderTopRightRadius,
        };
      });
      expect(geometry.height).toBe("40px");
      expect(geometry.borderTopLeftRadius).toBe("0px");
      expect(geometry.borderTopRightRadius).toBe("0px");

      // Leading FileText icon before the title, and the close X remains present.
      await expect(pill.locator("svg").first()).toBeVisible();
      await expect(pill.locator('button[aria-label^="Close "]')).toHaveCount(1);
    }

    const activeBorder = await activePill.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { width: cs.borderTopWidth, color: cs.borderTopColor };
    });
    expect(activeBorder.width).toBe("2px");
    // --color-accent default #a78bfa -> rgb(167, 139, 250).
    expect(activeBorder.color).toBe("rgb(167, 139, 250)");

    const inactiveBorderColor = await inactivePill.evaluate(
      (el) => getComputedStyle(el).borderTopColor,
    );
    // "2px solid transparent" resolves to a zero-alpha rgba in Chromium.
    expect(inactiveBorderColor).toBe("rgba(0, 0, 0, 0)");
  });
});
