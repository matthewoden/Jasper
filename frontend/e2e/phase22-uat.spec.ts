/**
 * Zen mode.
 *
 * The ribbon and both sidebars stay MOUNTED in zen — their grid track collapses to
 * 0px but each component keeps its own explicit CSS width — so the editor pane
 * merely covers them. Playwright's toBeVisible() checks display/visibility/opacity/
 * size, not paint order, and therefore does NOT catch this. Those three are
 * asserted with a same-point document.elementFromPoint occlusion check instead.
 * The tab bar and breadcrumb genuinely unmount, so plain assertions suffice there.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected, apiCreateNote } from "./helpers/phase7Helpers";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

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

/** Press the command-palette shortcut (Cmd/Ctrl+P) — the surviving palette entrance. */
async function pressCmdP(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+p`);
}

/** Press the zen-mode toggle shortcut (Cmd/Ctrl+.). */
async function pressZenToggle(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+.`);
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

  test("the command palette still opens (Cmd+P) while zen mode is active", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await pressZenToggle(page);
    await expect(page.locator('[data-zen="true"]')).toHaveCount(1, { timeout: 5_000 });

    await pressCmdP(page);
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  });
});
