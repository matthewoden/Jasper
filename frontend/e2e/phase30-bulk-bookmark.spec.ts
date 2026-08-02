/**
 * gap closure (30-12 CTX-02) — bulk-bookmark
 * client-store integrity.
 *
 * Root cause (VERIFICATION gap 3): `FileTree.handleBulkBookmark` loops
 * `await toggleBookmark(id)` over N selected notes. `toggleBookmark` used
 * to close over the render-time `bookmarks` array; every iteration after
 * the first overwrote the store with `B0 + created_i`, dropping earlier
 * iterations. Server state was always correct (each POST succeeded) — only
 * the client store, Bookmarks panel, and breadcrumb stars regressed to
 * showing just the LAST of the N bookmarks until a full reload.
 *
 * This spec proves the fix end-to-end against the embedded binary: select
 * 3 notes, bulk-bookmark them from the selection-aware tree context menu,
 * and assert the Bookmarks panel shows all 3 WITHOUT a reload.
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) before Playwright — the spec runs against the EMBEDDED binary.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive assertion uses
 * expect.poll / web-first assertions (memory no-flaky-tests). Run with
 * --repeat-each=3 to prove non-flake.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected, apiCreateNote } from "./helpers/phase7Helpers";
import { openNoteFromTree, noteRow } from "./helpers/openNoteFromTree";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

function sidebarNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Notes navigation" });
}

/** Click a SidebarTabRow tab (switches the panel; also reopens the sidebar). */
async function openSidebarTab(
  page: Page,
  label: "Notes" | "Search" | "Bookmarks",
): Promise<void> {
  await sidebarNav(page)
    .getByRole("button", { name: label, exact: true })
    .click();
}

// BookmarksPanel renders rows through the shared TreeRow component
// (quick task 260719-jv1) — bookmark rows carry `data-tree-row-kind`
// rather than a `data-testid="bookmark-row-*"` prefix.
function bookmarkRows(page: Page): Locator {
  return page.locator('[data-tree-row-kind="bookmark"]');
}

test.describe("@bulk-bookmark gap closure: bulk-bookmark client store integrity", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("bulk 'Bookmark 3 notes' from the tree's selection-aware menu leaves all 3 bookmarks visible in the Bookmarks panel without a reload", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteA = await apiCreateNote(
      page,
      jasper.baseURL,
      "bulk-bookmark-a.md",
      "",
      "# bulk-bookmark-a\n",
    );
    const noteB = await apiCreateNote(
      page,
      jasper.baseURL,
      "bulk-bookmark-b.md",
      "",
      "# bulk-bookmark-b\n",
    );
    const noteC = await apiCreateNote(
      page,
      jasper.baseURL,
      "bulk-bookmark-c.md",
      "",
      "# bulk-bookmark-c\n",
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteA);

    // Multi-select all three notes in the tree.
    await noteRow(page, noteA).click();
    await noteRow(page, noteB).click({ modifiers: [MOD] });
    await noteRow(page, noteC).click({ modifiers: [MOD] });
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const rows = Array.from(
            document.querySelectorAll('[data-tree-row-kind="note"]'),
          );
          return rows.filter(
            (r) =>
              r.parentElement?.getAttribute("aria-selected") === "true",
          ).length;
        });
      })
      .toBe(3);

    // Open the selection-aware bulk menu and invoke "Bookmark 3 notes".
    await noteRow(page, noteC).click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await menu.getByRole("menuitem", { name: "Bookmark 3 notes" }).click();

    // Toast confirms the bulk action fired.
    await expect(
      page.getByText("Bookmarked 3 notes", { exact: true }),
    ).toBeVisible({
      timeout: 5_000,
    });

    // NO reload — switch to the Bookmarks panel and assert all 3 are
    // present. This is the exact regression: pre-fix, only the LAST
    // bookmarked note (noteC) would be visible until a manual reload.
    // Each per-title assertion is a web-first (auto-retrying) locator
    // check rather than a one-shot allTextContents() snapshot, so it
    // tolerates the async note-title resolution that lags one tick
    // behind the row itself first appearing in the DOM.
    await openSidebarTab(page, "Bookmarks");
    await expect(
      bookmarkRows(page).filter({ hasText: "bulk-bookmark-a" }),
    ).toHaveCount(1, { timeout: 5_000 });
    await expect(
      bookmarkRows(page).filter({ hasText: "bulk-bookmark-b" }),
    ).toHaveCount(1, { timeout: 5_000 });
    await expect(
      bookmarkRows(page).filter({ hasText: "bulk-bookmark-c" }),
    ).toHaveCount(1, { timeout: 5_000 });
    await expect(bookmarkRows(page)).toHaveCount(3);
  });
});
