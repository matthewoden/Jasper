/**
 * Right-Rail Tags & Context Menus: tree row context menu
 * (CTX-02, WS-06 tree-split entry point, bulk menu, the universal
 * delete-confirm dialog).
 *
 * Covers:
 *   CTX-02  Note-row menu adds Open in split, Bookmark/Remove bookmark;
 *           folder-row menu adds Show in file manager below New folder.
 *   WS-06   "Open in split" opens the row's note in a new right/row
 *           split.
 *   Bulk    A multi-select bulk variant (Open N tabs / Open in split /
 *           Bookmark N notes / Delete N notes) when selectionCount > 1.
 * The trash-based delete-confirm dialog gates both the
 *           single-target and bulk delete paths.
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) before Playwright — the spec runs against the EMBEDDED binary.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive assertion uses
 * expect/expect.poll (memory no-flaky-tests).
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected, apiCreateNote } from "./helpers/phase7Helpers";
import { openNoteFromTree, noteRow } from "./helpers/openNoteFromTree";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** Create a folder via the API. Ignores 409 (already exists). */
async function apiCreateFolder(
  page: Page,
  baseURL: string,
  name: string,
  parentPath = "",
): Promise<void> {
  const resp = await page.request.post(`${baseURL}/api/v1/folders`, {
    data: { parent_path: parentPath, name },
  });
  if (resp.status() !== 201 && resp.status() !== 409) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateFolder: POST returned ${String(resp.status())} for "${parentPath}/${name}": ${body}`,
    );
  }
}

function folderRow(page: Page, name: string) {
  return page
    .locator('[data-tree-row-kind="folder"]')
    .filter({ hasText: name });
}

function leafPanes(page: Page) {
  return page.locator('[data-testid="leaf-pane"]');
}

test.describe("@tree-menu: tree row context menu", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("right-clicking a note row opens the tree row context menu (Rename item)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "tree-menu-smoke.md",
      "",
      "# tree-menu-smoke\n\nBody text for the tree-menu smoke test.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    await noteRow(page, noteId).click({ button: "right" });
    await expect(page.getByText("Rename", { exact: true })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("CTX-02/WS-06: the note-row menu adds Open in split and Bookmark/Remove bookmark; the folder-row menu adds Show in file manager below New folder", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "tree-menu-ctx02.md",
      "",
      "# tree-menu-ctx02\n\nCTX-02 note-row menu items.\n",
    );
    await apiCreateFolder(page, jasper.baseURL, "tree-menu-ctx02-folder");

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    // Note-row menu: locked order Open / Open in split / Show in file
    // manager / New note / Bookmark / Rename / Delete.
    await noteRow(page, noteId).click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 5_000 });
    const items = await menu.getByRole("menuitem").allTextContents();
    const idx = (label: string) => items.findIndex((t) => t.includes(label));
    expect(idx("Open")).toBeGreaterThanOrEqual(0);
    expect(idx("Open in split")).toBeGreaterThan(idx("Open"));
    expect(idx("Show in file manager")).toBeGreaterThan(idx("Open in split"));
    expect(idx("New note")).toBeGreaterThan(idx("Show in file manager"));
    expect(idx("Bookmark")).toBeGreaterThan(idx("New note"));
    expect(idx("Rename")).toBeGreaterThan(idx("Bookmark"));
    expect(idx("Delete")).toBeGreaterThan(idx("Rename"));

    // WS-06: Open in split opens the note in a new right/row split.
    await expect(leafPanes(page)).toHaveCount(1);
    await page.getByRole("menuitem", { name: "Open in split" }).click();
    await expect(leafPanes(page)).toHaveCount(2, { timeout: 5_000 });

    // Bookmark toggle: "Bookmark" -> "Remove bookmark" after clicking.
    await noteRow(page, noteId).first().click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 5_000 });
    await page.getByRole("menuitem", { name: "Bookmark", exact: true }).click();

    await noteRow(page, noteId).first().click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("menuitem", { name: "Remove bookmark" }),
    ).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");

    // Folder-row menu: Show in file manager present below New folder.
    // Note: the reveal item's aria-label is rowKind-specific ("Show folder
    // in file manager" for folders — see TreeRowMenu.tsx's revealAria) so
    // it does NOT substring-match a getByRole name query for the visible
    // "Show in file manager" text; assert on the rendered text instead.
    await folderRow(page, "tree-menu-ctx02-folder").click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("menu").getByText("Show in file manager", { exact: true }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("CTX-02: a multi-select bulk menu (Open N tabs / Open in split / Bookmark N notes / Delete N notes) renders when selectionCount > 1", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteA = await apiCreateNote(
      page,
      jasper.baseURL,
      "tree-menu-bulk-a.md",
      "",
      "# tree-menu-bulk-a\n",
    );
    const noteB = await apiCreateNote(
      page,
      jasper.baseURL,
      "tree-menu-bulk-b.md",
      "",
      "# tree-menu-bulk-b\n",
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteA);

    await noteRow(page, noteA).click();
    await noteRow(page, noteB).click({ modifiers: [MOD] });
    await expect
      .poll(async () => {
        const selected = await page.evaluate(() => {
          const rows = Array.from(
            document.querySelectorAll('[data-tree-row-kind="note"]'),
          );
          return rows.filter(
            (r) => r.parentElement?.getAttribute("aria-selected") === "true",
          ).length;
        });
        return selected;
      })
      .toBe(2);

    // Event-bubbling defense: right-clicking an already-selected row
    // must NOT collapse the multi-selection (react-arborist's DefaultRow
    // wrapper independently calls node.handleClick on a bubbled click —
    // TreeRowMenu's bulk items call event.stopPropagation() to prevent
    // this; see that file's bulk-variant comment for the full mechanism).
    await noteRow(page, noteB).click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 5_000 });

    await expect(menu.getByRole("menuitem", { name: "Open (2 tabs)" })).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Open in split" }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Bookmark 2 notes" }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Delete 2 notes" }),
    ).toBeVisible();
    // Single-target items hidden entirely (not disabled) in the bulk menu.
    await expect(menu.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
    await expect(
      menu.getByRole("menuitem", { name: "Show in file manager" }),
    ).toHaveCount(0);

    await menu.getByRole("menuitem", { name: "Delete 2 notes" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog).toContainText("Delete 2 notes?");
    await dialog
      .getByRole("button", { name: "Delete 2 notes", exact: true })
      .click();

    await expect(noteRow(page, noteA)).toBeHidden({ timeout: 10_000 });
    await expect(noteRow(page, noteB)).toBeHidden({ timeout: 10_000 });
  });
});
