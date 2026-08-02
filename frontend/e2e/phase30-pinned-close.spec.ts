/**
 * Pinned tabs must refuse to close via EVERY path, not just the x button — this
 * covers the remaining two, Alt+W and middle-click.
 *
 * Middle-click is driven with real page.mouse (button: "middle"), never a
 * synthetic auxclick.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected, apiCreateNote } from "./helpers/phase7Helpers";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

function tabStrip(page: Page): Locator {
  return page.getByTestId("tab-strip");
}

function tabPillIn(strip: Locator, title: string): Locator {
  return strip.getByRole("tab").filter({ hasText: title });
}

function pinGlyphIn(strip: Locator, title: string): Locator {
  return tabPillIn(strip, title).getByRole("button", {
    name: "Pinned tab — right-click to unpin",
  });
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
    `# ${title}\n\nBody text for the earlier pinned-close gap-closure spec.\n`,
  );
  await openNoteFromTree(page, noteId);
  return noteId;
}

/** Middle-click a pill via real pointer input (never synthetic auxclick). */
async function middleClick(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("pill bounding box unavailable");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "middle" });
  await page.mouse.up({ button: "middle" });
}

test.describe("@pinned-close gap closure: pinned tabs survive Alt+W and middle-click", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("a pinned tab survives Alt+W (refusal toast) AND middle-click; an unpinned tab closes on Alt+W", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const pinnedTitle = "pinned-close-alt-w-target";
    await openNoteAsTab(page, jasper.baseURL, pinnedTitle);

    const strip = tabStrip(page);
    await expect(strip.getByRole("tab")).toHaveCount(1);

    // Pin the tab via its context menu (same entry point as phase30-tab-menu-uat).
    await tabPillIn(strip, pinnedTitle).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin tab" }).click();
    await expect(pinGlyphIn(strip, pinnedTitle)).toBeVisible({ timeout: 5_000 });

    // (a) Alt+W on the pinned active tab refuses — tab survives, refusal toast appears.
    await page.keyboard.press("Alt+W");
    await expect(
      page.getByText("This tab is pinned — right-click to unpin"),
    ).toBeVisible({ timeout: 5_000 });
    await expect(tabPillIn(strip, pinnedTitle)).toHaveCount(1);

    // (b) Middle-click on the pinned pill also refuses — tab still survives.
    await middleClick(page, tabPillIn(strip, pinnedTitle));
    await expect(tabPillIn(strip, pinnedTitle)).toHaveCount(1);
    await expect(strip.getByRole("tab")).toHaveCount(1);

    // (c) A fresh UNPINNED tab still closes normally on Alt+W (no over-broad guard).
    const unpinnedTitle = "pinned-close-alt-w-unpinned";
    await openNoteAsTab(page, jasper.baseURL, unpinnedTitle);
    await expect(strip.getByRole("tab")).toHaveCount(2);
    // The newly-opened tab becomes the active tab — Alt+W targets it directly.
    await expect(tabPillIn(strip, unpinnedTitle)).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 5_000 },
    );
    await page.keyboard.press("Alt+W");
    await expect(tabPillIn(strip, unpinnedTitle)).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(tabPillIn(strip, pinnedTitle)).toHaveCount(1);
  });

  test("middle-click on an UNPINNED tab still closes it (no regression)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const title = "pinned-close-middle-click-unpinned";
    await openNoteAsTab(page, jasper.baseURL, title);

    const strip = tabStrip(page);
    await expect(strip.getByRole("tab")).toHaveCount(1);

    await middleClick(page, tabPillIn(strip, title));
    await expect(tabPillIn(strip, title)).toHaveCount(0, { timeout: 5_000 });
  });
});
