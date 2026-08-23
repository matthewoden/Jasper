/**
 * E2E gate for the four v1.4 bookmarks stories (JASPER-22/23/24/25), which
 * shipped with unit tests only. Everything here is driven through the real
 * sidebar against the embedded binary: the sort menu, the inline
 * create/rename inputs, the hover-revealed ⋯ menus and a real HTML5 drag.
 *
 * The properties jsdom structurally cannot reach, and the reason this file
 * exists: that a sorted view really withdraws the drag affordance instead of
 * writing an order it then ignores, that a folder created into the EMPTY
 * state actually paints a row, and that deleting a folder leaves its
 * bookmarks alive at the top level.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

// ─── Shared helpers (mirrors phase27-uat.spec.ts's isolation pattern) ───────

/**
 * Spawn a binary with an isolated JASPER_APP_HOME so GET /vault/current
 * returns THIS test's ephemeral vault — the bookmarks document AND the
 * workspace sort selection are both vault-scoped.
 */
async function spawnIsolated(): Promise<{ jasper: JasperHandle; appHome: string }> {
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-bmv14-apphome-"));
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
async function apiCreateNote(
  page: Page,
  baseURL: string,
  title: string,
): Promise<string> {
  const resp = await page.request.post(`${baseURL}/api/v1/notes`, {
    data: { parent_path: "", title },
  });
  if (resp.status() !== 201) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`apiCreateNote ${title}: ${String(resp.status())} ${body}`);
  }
  return ((await resp.json()) as { id: string }).id;
}

interface BookmarksDoc {
  folders: Array<{ id: string; name: string }>;
  bookmarks: Array<{
    id: string;
    note_id: string;
    folder_id: string | null;
    order: number;
  }>;
}

async function fetchBookmarks(page: Page, baseURL: string): Promise<BookmarksDoc> {
  const resp = await page.request.get(`${baseURL}/api/v1/bookmarks`);
  return (await resp.json()) as BookmarksDoc;
}

/** Server-side bookmark order (by note id), lowest `order` first. */
async function serverBookmarkOrder(
  page: Page,
  baseURL: string,
  titleOf: Map<string, string>,
): Promise<string[]> {
  const doc = await fetchBookmarks(page, baseURL);
  return doc.bookmarks
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((b) => titleOf.get(b.note_id) ?? b.note_id);
}

function sidebarNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Notes navigation" });
}

/** Click a SidebarTabRow tab (switches the panel; also reopens the sidebar). */
async function openSidebarTab(
  page: Page,
  label: "Notes" | "Search" | "Bookmarks",
): Promise<void> {
  await sidebarNav(page).getByRole("button", { name: label, exact: true }).click();
}

function bookmarkRows(page: Page): Locator {
  return page.locator('[data-tree-row-kind="bookmark"]');
}

/** Bookmark row labels in DOM (= visual) order — what the sort actually did. */
function bookmarkLabels(page: Page): Locator {
  return page.locator('[data-tree-row-kind="bookmark"] [data-tree-row-label]');
}

function bookmarkRowByTitle(page: Page, title: string): Locator {
  return bookmarkRows(page).filter({ hasText: title });
}

function folderRows(page: Page): Locator {
  return page.locator('[data-tree-row-kind="bookmark-folder"]');
}

function folderRowByName(page: Page, name: string): Locator {
  return folderRows(page).filter({ hasText: name });
}

/** Bookmark a note the way a user does: open it, click the breadcrumb star. */
async function bookmarkViaStar(page: Page, noteId: string): Promise<void> {
  await openSidebarTab(page, "Notes");
  await openNoteFromTree(page, noteId);
  const star = page.getByTestId("bookmark-star");
  await expect(star).toHaveAttribute("aria-label", "Bookmark this note");
  await star.click();
  await expect(star).toHaveAttribute("aria-label", "Remove bookmark");
}

/**
 * Open a row's ⋯ menu. The kebab is CSS hover-revealed, so the row must be
 * hovered first or Playwright's actionability check never sees it.
 */
async function openRowMenu(row: Locator, label: string): Promise<void> {
  await row.hover();
  const kebab = row.getByRole("button", { name: label });
  await expect(kebab).toBeVisible({ timeout: 5_000 });
  await kebab.click();
}

async function openSortMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sort bookmarks" }).click();
  await expect(page.getByRole("menuitem", { name: "Manual" })).toBeVisible({
    timeout: 5_000,
  });
}

/** The checked order is the only menu item rendering a (Check) glyph. */
function sortItemCheck(page: Page, label: string): Locator {
  return page.getByRole("menuitem", { name: label }).locator("svg");
}

const SORT_LABELS = [
  "Manual",
  "Name (A → Z)",
  "Name (Z → A)",
  "Modified (new → old)",
  "Modified (old → new)",
  "Created (new → old)",
  "Created (old → new)",
];

/** Every item the bookmark row's ⋯ menu offers — NoteOptionsMenu parity plus
 *  the two bookmark-specific entries (JASPER-25). */
const BOOKMARK_MENU_ITEMS = [
  "Rename",
  "Move to…",
  "Remove bookmark",
  "Move to bookmark folder",
  "Split right",
  "Split down",
  "Find",
  "Replace",
  "Reveal in navigation",
  "Show in file manager",
  "Delete",
];

// ─── JASPER-22 — sort menu: item set, Manual default, re-sort, persistence ──

test.describe("@bookmarks-v14 @bookmarks-sort JASPER-22: sort orders + Manual default + persistence", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("menu offers six note orders plus Manual, Manual is default, a pick re-sorts the panel and survives a reload", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    // Bookmarked in an order that is deliberately NOT alphabetical, so
    // "Manual is the default" is provable from the rows themselves and not
    // just from the checkmark.
    const charlie = await apiCreateNote(page, jasper.baseURL, "sort-charlie");
    const alpha = await apiCreateNote(page, jasper.baseURL, "sort-alpha");
    const bravo = await apiCreateNote(page, jasper.baseURL, "sort-bravo");
    await bookmarkViaStar(page, charlie);
    await bookmarkViaStar(page, alpha);
    await bookmarkViaStar(page, bravo);

    await openSidebarTab(page, "Bookmarks");
    await expect(bookmarkLabels(page)).toHaveText([
      "sort-charlie",
      "sort-alpha",
      "sort-bravo",
    ]);

    await openSortMenu(page);
    await expect(page.getByRole("menuitem")).toHaveText(SORT_LABELS);
    await expect(sortItemCheck(page, "Manual")).toHaveCount(1);
    await expect(sortItemCheck(page, "Name (A → Z)")).toHaveCount(0);

    await page.getByRole("menuitem", { name: "Name (A → Z)" }).click();
    await expect(bookmarkLabels(page)).toHaveText([
      "sort-alpha",
      "sort-bravo",
      "sort-charlie",
    ]);

    // The selection is workspace state, not localStorage (JASPER-22 LOCKED).
    await expect
      .poll(async () => {
        const resp = await page.request.get(`${jasper.baseURL}/api/v1/vault/workspace`);
        return ((await resp.json()) as { bookmarksSort?: string }).bookmarksSort;
      })
      .toBe("name-asc");

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );
    await page.waitForLoadState("networkidle");
    await openSidebarTab(page, "Bookmarks");
    await expect(bookmarkLabels(page)).toHaveText([
      "sort-alpha",
      "sort-bravo",
      "sort-charlie",
    ]);

    await openSortMenu(page);
    await expect(sortItemCheck(page, "Name (A → Z)")).toHaveCount(1);
    await expect(sortItemCheck(page, "Manual")).toHaveCount(0);

    // Back to Manual restores the drag-assigned order.
    await page.getByRole("menuitem", { name: "Manual" }).click();
    await expect(bookmarkLabels(page)).toHaveText([
      "sort-charlie",
      "sort-alpha",
      "sort-bravo",
    ]);
  });
});

// ─── JASPER-22 — drag-to-reorder lives only in Manual ───────────────────────

test.describe("@bookmarks-v14 @bookmarks-sort JASPER-22: drag-to-reorder is suppressed outside Manual", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("the same drag that reorders under Manual writes nothing under Name (A → Z)", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const ids = new Map<string, string>();
    const titleOf = new Map<string, string>();
    for (const name of ["drag-alpha", "drag-bravo", "drag-charlie"]) {
      const id = await apiCreateNote(page, jasper.baseURL, name);
      ids.set(name, id);
      titleOf.set(id, name);
      await bookmarkViaStar(page, id);
    }

    // Reordering happens inside a folder scope. The folder is created through
    // the panel; filing the three bookmarks into it is setup, so it goes
    // through the API (the kebab's move-to-folder path is driven for real in
    // the JASPER-25 scenario below) followed by a reload, so the panel
    // hydrates the arrangement from the server rather than from a WS race.
    await openSidebarTab(page, "Bookmarks");
    await page.getByRole("button", { name: "New bookmark folder" }).click();
    const folderInput = page.getByLabel("New bookmark folder name");
    await expect(folderInput).toBeVisible();
    await folderInput.fill("Box");
    await folderInput.press("Enter");
    await expect(folderRowByName(page, "Box")).toBeVisible({ timeout: 5_000 });

    const seeded = await fetchBookmarks(page, jasper.baseURL);
    const boxId = seeded.folders[0].id;
    for (const b of seeded.bookmarks) {
      const resp = await page.request.post(
        `${jasper.baseURL}/api/v1/bookmarks/${b.id}/folder`,
        { data: { folder_id: boxId } },
      );
      expect(resp.status()).toBe(200);
    }
    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );
    await page.waitForLoadState("networkidle");
    await openSidebarTab(page, "Bookmarks");
    await expect(bookmarkLabels(page)).toHaveText([
      "drag-alpha",
      "drag-bravo",
      "drag-charlie",
    ]);

    const doc = await fetchBookmarks(page, jasper.baseURL);
    const bookmarkIdOf = (noteTitle: string): string => {
      const noteId = ids.get(noteTitle);
      const found = doc.bookmarks.find((b) => b.note_id === noteId);
      if (!found) throw new Error(`no bookmark for ${noteTitle}`);
      return found.id;
    };
    const rowSelector = (noteTitle: string): string =>
      `[data-tree-row-kind="bookmark"][data-tree-row="${bookmarkIdOf(noteTitle)}"]`;

    // Manual: dropping charlie on the TOP half of the folder's first child
    // inserts it at index 0 of that folder (react-arborist's between-rows
    // insertion cursor).
    await page.dragAndDrop(rowSelector("drag-charlie"), rowSelector("drag-alpha"), {
      sourcePosition: { x: 60, y: 16 },
      targetPosition: { x: 60, y: 2 },
    });
    await expect(bookmarkLabels(page)).toHaveText([
      "drag-charlie",
      "drag-alpha",
      "drag-bravo",
    ]);
    await expect
      .poll(async () => serverBookmarkOrder(page, jasper.baseURL, titleOf), {
        timeout: 10_000,
      })
      .toEqual(["drag-charlie", "drag-alpha", "drag-bravo"]);

    // Switch to a sorted order — the view now disagrees with the stored order,
    // which is exactly the state where a silently-accepted drop would be lost.
    await openSortMenu(page);
    await page.getByRole("menuitem", { name: "Name (A → Z)" }).click();
    await expect(bookmarkLabels(page)).toHaveText([
      "drag-alpha",
      "drag-bravo",
      "drag-charlie",
    ]);

    // The identical gesture, now under a sorted order.
    await page.dragAndDrop(rowSelector("drag-bravo"), rowSelector("drag-alpha"), {
      sourcePosition: { x: 60, y: 16 },
      targetPosition: { x: 60, y: 2 },
    });

    // Nothing moved in the view...
    await expect(bookmarkLabels(page)).toHaveText([
      "drag-alpha",
      "drag-bravo",
      "drag-charlie",
    ]);
    // ...and, the part a unit test cannot see, nothing was written underneath
    // it either: Manual still shows the order the Manual-mode drag left.
    await openSortMenu(page);
    await page.getByRole("menuitem", { name: "Manual" }).click();
    await expect(bookmarkLabels(page)).toHaveText([
      "drag-charlie",
      "drag-alpha",
      "drag-bravo",
    ]);
    expect(await serverBookmarkOrder(page, jasper.baseURL, titleOf)).toEqual([
      "drag-charlie",
      "drag-alpha",
      "drag-bravo",
    ]);
  });
});

// ─── JASPER-23 — a folder created into the EMPTY state must appear ──────────

test.describe("@bookmarks-v14 @bookmarks-folder JASPER-23: create a folder with no bookmarks yet", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("one create against the empty panel yields exactly one visible folder row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    await openSidebarTab(page, "Bookmarks");
    await expect(page.getByTestId("bookmarks-empty-state")).toBeVisible();

    await page.getByRole("button", { name: "New bookmark folder" }).click();
    const input = page.getByLabel("New bookmark folder name");
    await expect(input).toBeVisible();
    await input.fill("Reading");
    await input.press("Enter");

    // The shipped bug: the empty state swallowed the new folder, so the row
    // never painted (and a retry produced a second folder server-side).
    await expect(folderRowByName(page, "Reading")).toBeVisible({ timeout: 5_000 });
    await expect(folderRows(page)).toHaveCount(1);
    await expect(page.getByTestId("bookmarks-empty-state")).toHaveCount(0);
    expect((await fetchBookmarks(page, jasper.baseURL)).folders).toHaveLength(1);

    // A second create proves the count assertion above is not vacuous.
    await page.getByRole("button", { name: "New bookmark folder" }).click();
    const second = page.getByLabel("New bookmark folder name");
    await expect(second).toBeVisible();
    await second.fill("Later");
    await second.press("Enter");
    await expect(folderRowByName(page, "Later")).toBeVisible({ timeout: 5_000 });
    await expect(folderRows(page)).toHaveCount(2);
    expect((await fetchBookmarks(page, jasper.baseURL)).folders).toHaveLength(2);

    // Still two after a reload — a swallowed duplicate would surface here.
    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );
    await openSidebarTab(page, "Bookmarks");
    await expect(folderRows(page)).toHaveCount(2, { timeout: 10_000 });
  });
});

// ─── JASPER-24 — duplicate folder names are refused, inline, in place ───────

test.describe("@bookmarks-v14 @bookmarks-dupe JASPER-24: duplicate name refused on create", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("a case-insensitive clash shows an inline error and keeps the input open with the typed text", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    await openSidebarTab(page, "Bookmarks");
    await page.getByRole("button", { name: "New bookmark folder" }).click();
    await page.getByLabel("New bookmark folder name").fill("Work");
    await page.getByLabel("New bookmark folder name").press("Enter");
    await expect(folderRowByName(page, "Work")).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: "New bookmark folder" }).click();
    const input = page.getByLabel("New bookmark folder name");
    await input.fill("WORK");
    await input.press("Enter");

    await expect(page.getByRole("alert")).toHaveText(
      "a folder with this name already exists",
    );
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("WORK");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(folderRows(page)).toHaveCount(1);
    expect((await fetchBookmarks(page, jasper.baseURL)).folders).toHaveLength(1);

    // Correcting in place commits without reopening the input.
    await input.fill("Personal");
    await input.press("Enter");
    await expect(folderRowByName(page, "Personal")).toBeVisible({ timeout: 5_000 });
    await expect(folderRows(page)).toHaveCount(2);
  });
});

test.describe("@bookmarks-v14 @bookmarks-dupe JASPER-24: duplicate name refused on rename", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("rename to another folder's name is refused inline; recasing a folder's OWN name succeeds", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    await openSidebarTab(page, "Bookmarks");
    for (const name of ["Work", "Personal"]) {
      await page.getByRole("button", { name: "New bookmark folder" }).click();
      const create = page.getByLabel("New bookmark folder name");
      await expect(create).toBeVisible();
      await create.fill(name);
      await create.press("Enter");
      await expect(folderRowByName(page, name)).toBeVisible({ timeout: 5_000 });
    }

    await openRowMenu(folderRowByName(page, "Personal"), "Bookmark folder options");
    await page.getByRole("menuitem", { name: "Rename folder" }).click();

    const rename = page.getByLabel("Bookmark folder name");
    await expect(rename).toBeVisible({ timeout: 5_000 });
    await expect(rename).toHaveValue("Personal");
    await rename.fill("WORK");
    await rename.press("Enter");

    await expect(page.getByRole("alert")).toHaveText(
      "a folder with this name already exists",
    );
    await expect(rename).toBeVisible();
    await expect(rename).toHaveValue("WORK");
    await expect(rename).toHaveAttribute("aria-invalid", "true");
    expect(
      (await fetchBookmarks(page, jasper.baseURL)).folders.map((f) => f.name).sort(),
    ).toEqual(["Personal", "Work"]);

    // Escape abandons the rename; the original row comes back.
    await rename.press("Escape");
    await expect(folderRowByName(page, "Personal")).toBeVisible({ timeout: 5_000 });

    // A case variant of the folder's OWN name is not a self-collision.
    await openRowMenu(folderRowByName(page, "Personal"), "Bookmark folder options");
    await page.getByRole("menuitem", { name: "Rename folder" }).click();
    const recase = page.getByLabel("Bookmark folder name");
    await expect(recase).toBeVisible({ timeout: 5_000 });
    await recase.fill("personal");
    await recase.press("Enter");

    await expect(page.getByLabel("Bookmark folder name")).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(folderRows(page)).toHaveCount(2);
    await expect
      .poll(async () =>
        (await fetchBookmarks(page, jasper.baseURL)).folders
          .map((f) => f.name)
          .sort(),
      )
      .toEqual(["Work", "personal"]);
  });
});

// ─── JASPER-25 — ⋯ menus for bookmark rows and bookmark folders ─────────────

test.describe("@bookmarks-v14 @bookmarks-menus JASPER-25: bookmark + folder options menus", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("row menu offers Remove bookmark + Move to bookmark folder; deleting a folder keeps its bookmark at top level", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const noteId = await apiCreateNote(page, jasper.baseURL, "menus-note");
    await bookmarkViaStar(page, noteId);
    await openSidebarTab(page, "Bookmarks");

    const row = bookmarkRowByTitle(page, "menus-note");
    await expect(row).toBeVisible();

    await openRowMenu(row, "Bookmark options");
    await expect(page.getByRole("menuitem")).toHaveText(BOOKMARK_MENU_ITEMS);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem")).toHaveCount(0);

    await page.getByRole("button", { name: "New bookmark folder" }).click();
    const create = page.getByLabel("New bookmark folder name");
    await expect(create).toBeVisible();
    await create.fill("Work");
    await create.press("Enter");
    await expect(folderRowByName(page, "Work")).toBeVisible({ timeout: 5_000 });

    await openRowMenu(row, "Bookmark options");
    await page.getByRole("menuitem", { name: "Move to bookmark folder" }).click();
    await page.getByRole("menuitem", { name: "Work", exact: true }).click();

    // Nested: a level-1 row draws one indent guide per ancestor level.
    await expect
      .poll(async () => row.locator('[data-testid="tree-indent-guide"]').count(), {
        timeout: 10_000,
      })
      .toBe(1);
    await expect
      .poll(async () => {
        const doc = await fetchBookmarks(page, jasper.baseURL);
        return doc.bookmarks[0]?.folder_id;
      })
      .not.toBeNull();

    await openRowMenu(folderRowByName(page, "Work"), "Bookmark folder options");
    await expect(page.getByRole("menuitem")).toHaveText([
      "Rename folder",
      "Delete folder",
    ]);
    await page.getByRole("menuitem", { name: "Delete folder" }).click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog).toContainText("Delete bookmark folder?");
    await expect(dialog).toContainText("move to the top level");
    await dialog.getByRole("button", { name: "Delete folder" }).click();

    // The folder goes; the bookmark SURVIVES, back at the top level.
    await expect(folderRows(page)).toHaveCount(0, { timeout: 10_000 });
    await expect(row).toBeVisible();
    await expect(row.locator('[data-testid="tree-indent-guide"]')).toHaveCount(0);
    await expect
      .poll(async () => {
        const doc = await fetchBookmarks(page, jasper.baseURL);
        return doc.bookmarks.map((b) => b.folder_id);
      })
      .toEqual([null]);

    // "Remove bookmark" is the row menu's own destructive action.
    await openRowMenu(row, "Bookmark options");
    await page.getByRole("menuitem", { name: "Remove bookmark" }).click();
    await expect(bookmarkRows(page)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId("bookmarks-empty-state")).toBeVisible();
  });
});
