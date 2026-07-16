/**
 * Phase 22 UAT — Command Palette (unified Cmd+K) + Zen Mode.
 *
 * PALETTE-01/02: Cmd+K opens a unified 620px palette merging notes + commands
 *   (each row kind-badged Note/Cmd, no section headers); Cmd+P (commands-only)
 *   and Cmd+O (notes-only) remain unchanged. Esc hint always present; arrow
 *   keys navigate, Enter activates, Esc/overlay-click close.
 *
 * ZEN-01: Cmd+. / the StatusBar button toggle zen mode, hiding the activity
 *   ribbon, both sidebars, the tab bar, and the breadcrumb band while the
 *   StatusBar stays visible; the reading column reflows 760px -> 700px; the
 *   palette remains fully operational while zen is active; toggling off
 *   restores the exact prior layout.
 *
 * Occlusion note: per Plan 22-03, the ribbon / left sidebar / right sidebar
 * stay MOUNTED in zen (their grid track collapses to 0px, but each component
 * keeps its own explicit CSS width) rather than unmounting — confirmed by a
 * pre-flight diagnostic showing `document.elementFromPoint` at each
 * component's visual center resolves to the editor's `.cm-scroller` (i.e.
 * the editor pane visually covers them; a real user cannot see or click
 * them). Plain Playwright `toBeVisible()` does not detect this occlusion
 * (it only checks display/visibility/opacity/size, not paint order), so
 * this suite verifies "not visible to the user" via a same-point
 * `elementFromPoint` occlusion check for those three elements. The tab bar
 * and breadcrumb genuinely unmount in zen (`{!zen && (...)}` guards), so
 * plain visibility/count assertions are used for those two.
 *
 * Harness mirrors phase21-uat.spec.ts: spawnJasper() per describe block
 * against a rebuilt binary, real page interactions, @phase22 tag.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive assertion uses
 * expect/expect.poll.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import {
  waitForConnected,
  openCommandMenu,
  apiCreateNote,
  pressShortcut,
} from "./helpers/phase7Helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARTIFACTS_DIR = path.join(__dirname, ".artifacts");

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const ZEN_WIDTH_TOLERANCE_PX = 4;

function ensureArtifactsDir(): void {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }
}

/** Press the unified-palette shortcut (Cmd/Ctrl+K). */
async function pressCmdK(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+k`);
}

/** Press the zen-mode toggle shortcut (Cmd/Ctrl+.). */
async function pressZenToggle(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+.`);
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

/**
 * Returns true when the element at `locator`'s own visual center point is
 * NOT `locator` itself and not one of its descendants — i.e. something else
 * (the editor pane, in zen mode) is painted on top of it, so a real user
 * cannot see or click it. See the file-header "Occlusion note" above.
 */
async function isOccludedByOtherContent(locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox();
  if (!box || box.width === 0 || box.height === 0) return true;
  return await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const topEl = document.elementFromPoint(cx, cy);
    if (!topEl) return true;
    return topEl !== el && !el.contains(topEl);
  });
}

test.describe("@phase22 command palette — unified Cmd+K mode + scoped-binding regression", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
    ensureArtifactsDir();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Cmd+K opens a 620px unified palette with an always-visible Esc hint; results carry Note/Cmd kind badges and interleave on a matching query", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await apiCreateNote(
      page,
      jasper.baseURL,
      "notetestalpha.md",
      "",
      "# notetestalpha\n\nBody text for the unified palette test.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await pressCmdK(page);
    const dialog = page.getByRole("dialog", { name: "Search everything" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The card's ~140ms popIn keyframe animates from scale(0.98) -> scale(1);
    // poll past the transition so the measured width reflects the settled
    // 620px, not an in-flight animation frame.
    await expect
      .poll(async () => (await dialog.boundingBox())?.width ?? 0, { timeout: 2_000 })
      .toBe(620);

    await expect(dialog.locator("kbd", { hasText: "Esc" })).toBeVisible({
      timeout: 5_000,
    });

    // Empty query: at least one note row, carrying the "Note" kind badge.
    const emptyNoteRow = dialog.locator('[data-row-kind="note"]').first();
    await expect(emptyNoteRow).toBeVisible({ timeout: 5_000 });
    await expect(emptyNoteRow.getByText("Note", { exact: true })).toBeVisible();

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "phase22-palette-unified-empty.png"),
      fullPage: false,
    });

    // Query "note" fuzzy-matches both the seeded note title and the
    // registered "New note" command label -> both kinds must interleave,
    // each carrying its own kind badge, with no GroupItem header rows.
    await dialog.getByRole("textbox").fill("note");
    const matchedNoteRow = dialog.locator('[data-row-kind="note"]').first();
    const matchedCmdRow = dialog.locator('[data-row-kind="cmd"]').first();
    await expect(matchedNoteRow).toBeVisible({ timeout: 5_000 });
    await expect(matchedCmdRow).toBeVisible({ timeout: 5_000 });
    await expect(matchedNoteRow.getByText("Note", { exact: true })).toBeVisible();
    await expect(matchedCmdRow.getByText("Cmd", { exact: true })).toBeVisible();
    await expect(dialog.locator('[data-row-kind="group"]')).toHaveCount(0);

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "phase22-palette-unified-query.png"),
      fullPage: false,
    });
  });

  test("empty-query palette is notes-first; ArrowDown moves the selection and Enter activates the newly selected note", async ({
    page,
  }) => {
    // apiCreateNote's create-then-PUT sequence gives both notes an
    // updated_at within the same second, so which of the two sorts first
    // under the recency tiebreaker is not guaranteed -- the assertions
    // below read each row's own title dynamically rather than assuming a
    // fixed alpha/beta order.
    await apiCreateNote(
      page,
      jasper.baseURL,
      "arrow-note-alpha.md",
      "",
      "# arrow-note-alpha\n\nAlpha body.\n",
    );
    await apiCreateNote(
      page,
      jasper.baseURL,
      "arrow-note-beta.md",
      "",
      "# arrow-note-beta\n\nBeta body.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await pressCmdK(page);
    const dialog = page.getByRole("dialog", { name: "Search everything" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // A fresh vault always seeds one "scratchpad.md" note (older than
    // anything created in-test); scope to our two uniquely-named notes so
    // the count assertion is unaffected by that pre-existing note. Both
    // notes' updated_at postdates scratchpad's vault-init timestamp, so
    // they occupy indices 0/1 in the full (unfiltered) selection order --
    // scratchpad is guaranteed to sort after them.
    const rows = dialog
      .locator('[data-row-kind="note"]')
      .filter({ hasText: /arrow-note-(alpha|beta)/ });
    await expect(rows).toHaveCount(2, { timeout: 5_000 });
    const firstRow = rows.nth(0);
    const secondRow = rows.nth(1);

    const TRANSPARENT = "rgba(0, 0, 0, 0)";
    await expect
      .poll(() => firstRow.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe(TRANSPARENT);

    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => secondRow.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe(TRANSPARENT);
    await expect
      .poll(() => firstRow.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(TRANSPARENT);

    // Read the ArrowDown-selected row's own title span (not the whole row's
    // concatenated text, which also includes the path suffix + kind badge)
    // before activating -- this is what Enter must open.
    const expectedTitle = await secondRow.locator("span").first().innerText();

    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId("editor-title-element")).toHaveText(
      expectedTitle,
      { timeout: 5_000 },
    );
  });

  test("with a tab already open, palette-selecting a different note switches the visible editor (CR-01)", async ({
    page,
  }) => {
    const idA = await apiCreateNote(
      page,
      jasper.baseURL,
      "cr01-note-a.md",
      "",
      "# cr01-note-a\n\nNote A body.\n",
    );
    await apiCreateNote(
      page,
      jasper.baseURL,
      "cr01-note-b.md",
      "",
      "# cr01-note-b\n\nNote B body.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    // App.tsx keeps one EditorPane mounted per open tab (hidden via CSS for
    // inactive tabs, never unmounted -- TAB-13 flush-on-close discipline), so
    // once two tabs are open, `editor-title-element` resolves to more than
    // one DOM node; scope to the one that is actually visible to the user.
    const visibleEditorTitle = page
      .getByTestId("editor-title-element")
      .and(page.locator(":visible"));

    // Establish the tabs-open precondition: open note A from the tree first,
    // which the zero-tab Enter-activation test above never reaches.
    await openNoteFromTree(page, idA);
    await expect(visibleEditorTitle).toHaveText("cr01-note-a", {
      timeout: 5_000,
    });

    await pressCmdK(page);
    const dialog = page.getByRole("dialog", { name: "Search everything" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await dialog.getByRole("textbox").fill("cr01-note-b");
    const noteBRow = dialog
      .locator('[data-row-kind="note"]')
      .filter({ hasText: "cr01-note-b" });
    await expect(noteBRow).toHaveCount(1, { timeout: 5_000 });
    await noteBRow.click();

    await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    await expect(visibleEditorTitle).toHaveText("cr01-note-b", {
      timeout: 5_000,
    });
  });

  test("Esc and overlay-click both close the unified palette", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const dialog = page.getByRole("dialog", { name: "Search everything" });

    await pressCmdK(page);
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });

    await pressCmdK(page);
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    // Radix's DismissableLayer attaches its outside-pointerdown listener in
    // an effect that runs a tick after the Content mounts; a click fired in
    // that narrow window can be missed (confirmed via a same-point
    // elementFromPoint check: the overlay IS the topmost element, but the
    // very first click can still race the listener attach). Retry the click
    // inside expect.poll rather than adding a fixed sleep -- deterministic,
    // no arbitrary wait.
    await expect
      .poll(
        async () => {
          await page.mouse.click(5, 5);
          return await dialog.count();
        },
        { timeout: 5_000 },
      )
      .toBe(0);
  });

  test("Cmd+P remains commands-only and Cmd+O remains notes-only (D-02 scoped-binding regression)", async ({
    page,
  }) => {
    await apiCreateNote(
      page,
      jasper.baseURL,
      "regression-note.md",
      "",
      "# regression-note\n\nBody.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await openCommandMenu(page, "commands");
    const commandsDialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(commandsDialog.locator('[data-row-kind="cmd"]').first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(commandsDialog.locator('[data-row-kind="note"]')).toHaveCount(0);
    await pressShortcut(page, "EscKey");
    await expect(commandsDialog).toHaveCount(0, { timeout: 5_000 });

    await openCommandMenu(page, "notes");
    const notesDialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(notesDialog.locator('[data-row-kind="note"]').first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(notesDialog.locator('[data-row-kind="cmd"]')).toHaveCount(0);
  });
});

test.describe("@phase22 zen mode", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
    ensureArtifactsDir();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Cmd+. hides the ribbon, both sidebars, tab bar, and breadcrumb while the StatusBar stays visible, and restores the prior layout on toggle-off", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "zen-chrome-note.md",
      "",
      "# zen-chrome-note\n\nBody text for the zen chrome-gating test.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    const ribbon = page.locator('nav[aria-label="Activity ribbon"]');
    const sidebar = page.locator('nav[aria-label="Notes navigation"]');
    const rightRail = page.locator("aside");
    const tabStrip = page.getByTestId("tab-strip");
    const breadcrumb = page.getByTestId("note-breadcrumb");
    const statusBar = page.getByTestId("status-bar");

    await expect(ribbon).toBeVisible({ timeout: 5_000 });
    await expect(sidebar).toBeVisible({ timeout: 5_000 });
    await expect(rightRail).toBeVisible({ timeout: 5_000 });
    await expect(tabStrip).toBeVisible({ timeout: 5_000 });
    await expect(breadcrumb).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(() => isOccludedByOtherContent(ribbon), { timeout: 5_000 })
      .toBe(false);

    await pressZenToggle(page);
    await expect(page.locator('[data-zen="true"]')).toHaveCount(1, { timeout: 5_000 });

    // Ribbon/left-sidebar/right-sidebar stay mounted (0px grid-track
    // collapse, see file header) but must be visually occluded by the
    // editor pane -- a real user sees no chrome there.
    await expect
      .poll(() => isOccludedByOtherContent(ribbon), { timeout: 5_000 })
      .toBe(true);
    await expect
      .poll(() => isOccludedByOtherContent(sidebar), { timeout: 5_000 })
      .toBe(true);
    await expect
      .poll(() => isOccludedByOtherContent(rightRail), { timeout: 5_000 })
      .toBe(true);
    // Tab bar and breadcrumb genuinely unmount in zen.
    await expect(tabStrip).toHaveCount(0, { timeout: 5_000 });
    await expect(breadcrumb).toHaveCount(0, { timeout: 5_000 });
    await expect(statusBar).toBeVisible({ timeout: 5_000 });

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "phase22-zen-on.png"),
      fullPage: false,
    });

    await pressZenToggle(page);
    await expect(page.locator('[data-zen="true"]')).toHaveCount(0, { timeout: 5_000 });

    await expect
      .poll(() => isOccludedByOtherContent(ribbon), { timeout: 5_000 })
      .toBe(false);
    await expect
      .poll(() => isOccludedByOtherContent(sidebar), { timeout: 5_000 })
      .toBe(false);
    await expect
      .poll(() => isOccludedByOtherContent(rightRail), { timeout: 5_000 })
      .toBe(false);
    await expect(tabStrip).toBeVisible({ timeout: 5_000 });
    await expect(breadcrumb).toBeVisible({ timeout: 5_000 });
    await expect(statusBar).toBeVisible({ timeout: 5_000 });

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "phase22-zen-off.png"),
      fullPage: false,
    });
  });

  test("the StatusBar zen button is a second bidirectional zen entrance", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const zenButton = page.getByRole("button", { name: "Toggle zen mode" });
    await expect(zenButton).toBeVisible({ timeout: 5_000 });

    await zenButton.click();
    await expect(page.locator('[data-zen="true"]')).toHaveCount(1, { timeout: 5_000 });

    await zenButton.click();
    await expect(page.locator('[data-zen="true"]')).toHaveCount(0, { timeout: 5_000 });
  });

  test("the reading column reflows from ~760px to ~700px when zen activates", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "zen-geometry-note.md",
      "",
      "# zen-geometry-note\n\nSome body text to render the reading column.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    const cmContent = page.locator(".cm-content:visible").first();
    await expect(cmContent).toBeVisible({ timeout: 10_000 });

    let box = await cmContent.boundingBox();
    await expect
      .poll(async () => {
        box = await cmContent.boundingBox();
        return (box?.width ?? 0) > 0;
      }, { timeout: 5_000 })
      .toBe(true);
    expect(box?.width).toBeLessThanOrEqual(760);

    await pressZenToggle(page);
    await expect(page.locator('[data-zen="true"]')).toHaveCount(1, { timeout: 5_000 });

    await expect
      .poll(async () => {
        box = await cmContent.boundingBox();
        return Math.abs((box?.width ?? 0) - 700);
      }, { timeout: 5_000 })
      .toBeLessThanOrEqual(ZEN_WIDTH_TOLERANCE_PX);
  });

  test("the command palette still opens (Cmd+K) while zen mode is active", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await pressZenToggle(page);
    await expect(page.locator('[data-zen="true"]')).toHaveCount(1, { timeout: 5_000 });

    await pressCmdK(page);
    const dialog = page.getByRole("dialog", { name: "Search everything" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  });
});
