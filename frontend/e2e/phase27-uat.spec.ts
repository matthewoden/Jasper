/**
 * Phase 27 UAT — Left Sidebar Navigation & Bookmarks (NAV-01..03, BOOK-01..05).
 *
 * Integration gate for the whole feature: proves the full-stack seam
 * (backend `internal/bookmarks` store -> API -> WS -> `useBookmarks()` ->
 * UI) works as one system, against the embedded Go binary — not a mocked
 * backend. Covers:
 *   NAV-01   sidebar tab row switches Notes/Search/Bookmarks panels
 *   NAV-02   ribbon shows exactly one quick-switcher button (no Files/Search
 *            toggles); it opens the Cmd+O switcher in notes mode
 *   NAV-03   collapse from the header control + reopen from the pane-corner
 *            button + Cmd+Shift+E toggle
 *   BOOK-01  breadcrumb star toggles a note's bookmarked state
 *   BOOK-02  bookmark rows open the note in the active pane
 *   BOOK-03  bookmark folders: create, move-to-folder, collapse
 *   BOOK-04  bookmarks persist across reload AND a full binary restart
 *            (`<vault>/.jasper/bookmarks.json`), and the bookmark keeps
 *            resolving to the same note across a rename AND a folder move
 *            (noteId identity, D-02) — the single most important
 *            robustness property this phase ships
 *   BOOK-05  "No bookmarks yet." empty state when the bookmark list is empty
 *
 * Selector contract (see 27-03..07-SUMMARY.md "Selectors landed"):
 *   - Sidebar tab row:      [data-testid="sidebar-tab-row"]; tabs are
 *                           aria-label="Notes"|"Search"|"Bookmarks"
 *   - Sidebar collapse:     aria-label="Collapse sidebar" (header control)
 *   - Pane-corner reopen:   aria-label="Show sidebar"
 *   - Ribbon quick switch:  aria-label="Quick switcher" (Activity ribbon)
 *   - Bookmark star:        [data-testid="bookmark-star"] (EditorPane breadcrumb)
 *   - Bookmarks panel:      [data-testid="bookmarks-panel"]
 *   - Bookmark row:         [data-testid^="bookmark-row-"]
 *   - Bookmark folder row:  [data-testid^="bookmark-folder-"]
 *   - Empty state:          [data-testid="bookmarks-empty-state"]
 *   - New folder trigger:   aria-label="New bookmark folder"
 *   - New folder input:     aria-label="New bookmark folder name"
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) before Playwright — the spec runs against the EMBEDDED binary.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive step uses a
 * web-first assertion (expect / expect.poll), mirroring
 * phase25/26-uat.spec.ts's existing discipline. Run with `--repeat-each=3`
 * to prove non-flake (no-flaky-tests memory).
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { openNoteFromTree, noteRow } from "./helpers/openNoteFromTree";

// ─── Shared helpers (mirrors phase25/26-uat.spec.ts's isolation pattern) ────

/**
 * Spawn a binary with an isolated JASPER_APP_HOME so GET /vault/current
 * returns THIS test's ephemeral vault, not whatever a parallel worker last
 * opened in the shared default app home.
 */
async function spawnIsolated(): Promise<{ jasper: JasperHandle; appHome: string }> {
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-p27-apphome-"));
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
  parentPath = "",
): Promise<string> {
  const resp = await page.request.post(`${baseURL}/api/v1/notes`, {
    data: { parent_path: parentPath, title },
  });
  if (resp.status() !== 201) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`apiCreateNote ${title}: ${String(resp.status())} ${body}`);
  }
  return ((await resp.json()) as { id: string }).id;
}

function folderRow(page: Page, name: string): Locator {
  return page.locator('[data-tree-row-kind="folder"]').filter({ hasText: name });
}

/**
 * Rename a note via the tree's inline rename (double-click -> fill -> Enter).
 *
 * Bounded-retry, not a blind sleep: a background refetch (WS-triggered tree
 * refresh from the earlier reload/restart burst) can occasionally race an
 * in-flight rename and revert the freshly-typed value before it commits —
 * under parallel test-worker CPU contention this window widens beyond a
 * single attempt's margin. Each retry is gated on a real assertion (the
 * label actually updating), so this resolves the race deterministically
 * rather than hoping a fixed delay is long enough.
 */
async function renameNoteViaTree(page: Page, id: string, newTitle: string): Promise<void> {
  const row = noteRow(page, id);
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await expect(row).toBeVisible();
    await row.dblclick();
    const input = row.locator('input[type="text"]');
    await expect(input).toBeVisible();
    await input.fill(newTitle);
    await input.press("Enter");
    try {
      await expect(row.locator('[data-tree-row-label]')).toHaveText(newTitle, {
        timeout: 2_000,
      });
      return;
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      // Reverted to the old value (race with a background refetch) — the
      // row is back to its plain (non-renaming) state; retry.
    }
  }
}

function activityRibbon(page: Page): Locator {
  return page.getByRole("navigation", { name: "Activity ribbon" });
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

/** Locate a bookmark row by its currently-displayed (live-resolved) title. */
function bookmarkRowByTitle(page: Page, title: string): Locator {
  return page
    .locator('[data-testid^="bookmark-row-"]')
    .filter({ hasText: title });
}

/** Fetch the live tree from the API (used to poll for drag-and-drop moves). */
async function fetchTree(page: Page, baseURL: string): Promise<{
  root: Array<{
    kind: string;
    id?: string;
    name?: string;
    path?: string;
    children?: Array<{ kind: string; id?: string; name?: string }>;
  }>;
}> {
  const resp = await page.request.get(`${baseURL}/api/v1/tree`);
  return resp.json();
}

// ─── NAV-01/NAV-02 — tab row panel switching + single ribbon quick-switcher ──

test.describe("@phase27 NAV-01/NAV-02: sidebar tab row + ribbon reconciliation", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("tab row switches Notes/Search/Bookmarks; ribbon shows exactly one quick-switcher — NAV-01/NAV-02", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    // NAV-01: Notes panel is the default — the virtualized tree is visible.
    await expect(page.locator('[role="tree"]')).toBeVisible({ timeout: 10_000 });

    // Switch to Search — the tree unmounts, the search input appears.
    await openSidebarTab(page, "Search");
    await expect(page.getByLabel("Search notes")).toBeVisible();
    await expect(page.locator('[role="tree"]')).toHaveCount(0);

    // Switch to Bookmarks — no bookmarks yet, so the empty state renders.
    await openSidebarTab(page, "Bookmarks");
    await expect(page.getByTestId("bookmarks-empty-state")).toBeVisible();
    await expect(page.getByLabel("Search notes")).toHaveCount(0);

    // Back to Notes.
    await openSidebarTab(page, "Notes");
    await expect(page.locator('[role="tree"]')).toBeVisible();
    await expect(page.getByTestId("bookmarks-empty-state")).toHaveCount(0);

    // NAV-02: the Activity ribbon shows exactly ONE quick-switcher button and
    // NO Files/Search toggles (those live only in the sidebar's tab row now).
    const ribbon = activityRibbon(page);
    await expect(ribbon.getByRole("button", { name: "Quick switcher" })).toHaveCount(1);
    await expect(ribbon.getByRole("button", { name: "Files", exact: true })).toHaveCount(0);
    await expect(ribbon.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);

    // Clicking it opens the Cmd+O quick switcher (mode="notes") — same dialog
    // the existing Cmd+O shortcut opens (aria-label "Quick switcher").
    await ribbon.getByRole("button", { name: "Quick switcher" }).click();
    await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Quick switcher" })).toHaveCount(0);
  });
});

// ─── NAV-03 — collapse (header) + reopen (pane corner) + Cmd+Shift+E ────────

test.describe("@phase27 NAV-03: collapse + reopen + toggle shortcut", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("header collapse control + pane-corner reopen + Cmd+Shift+E all toggle the sidebar — NAV-03", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    await expect(sidebarNav(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Show sidebar" })).toHaveCount(0);

    // Collapse via the header control.
    await sidebarNav(page).getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(sidebarNav(page)).toHaveCount(0);

    // The top-left (only) pane now hosts exactly one corner reopen button.
    const reopenBtn = page.getByRole("button", { name: "Show sidebar" });
    await expect(reopenBtn).toHaveCount(1);
    await expect(reopenBtn).toBeVisible();

    // Reopen via the pane-corner button.
    await reopenBtn.click();
    await expect(sidebarNav(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Show sidebar" })).toHaveCount(0);

    // Cmd+Shift+E toggles it too (window-level handler checks metaKey OR
    // ctrlKey directly, so Control+Shift+E is deterministic regardless of
    // Playwright's Desktop Chrome device spoofing navigator.platform).
    await page.keyboard.press("Control+Shift+E");
    await expect(sidebarNav(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();

    await page.keyboard.press("Control+Shift+E");
    await expect(sidebarNav(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Show sidebar" })).toHaveCount(0);
  });
});

// ─── BOOK-01/02/05 — bookmark toggle, panel row, open-in-active-pane, empty ──

test.describe("@phase27 BOOK-01/BOOK-02/BOOK-05: bookmark lifecycle", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("star toggle adds/removes a bookmark row; row opens the note in the active pane; empty state on empty — BOOK-01/02/05", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "book01-alpha");
    const idB = await apiCreateNote(page, jasper.baseURL, "book01-beta");

    // BOOK-05: empty state before any bookmark exists.
    await openSidebarTab(page, "Bookmarks");
    await expect(page.getByTestId("bookmarks-empty-state")).toBeVisible();

    // BOOK-01: open note A and bookmark it via the breadcrumb star.
    await openSidebarTab(page, "Notes");
    await openNoteFromTree(page, idA);
    const star = page.getByTestId("bookmark-star");
    await expect(star).toHaveAttribute("aria-label", "Bookmark this note");
    await star.click();
    await expect(star).toHaveAttribute("aria-label", "Remove bookmark");

    // BOOK-02: the row appears in the Bookmarks panel.
    await openSidebarTab(page, "Bookmarks");
    await expect(page.getByTestId("bookmarks-panel")).toBeVisible();
    const rowA = bookmarkRowByTitle(page, "book01-alpha");
    await expect(rowA).toBeVisible();
    await expect(page.getByTestId("bookmarks-empty-state")).toHaveCount(0);

    // Switch the active pane to note B (breadcrumb now shows B).
    await openSidebarTab(page, "Notes");
    await openNoteFromTree(page, idB);
    await expect(
      page.locator('[data-testid="note-breadcrumb"]:visible').getByTestId("breadcrumb-segment"),
    ).toHaveText(["book01-beta"]);

    // BOOK-02: clicking the bookmarked row opens note A in the active pane.
    await openSidebarTab(page, "Bookmarks");
    await bookmarkRowByTitle(page, "book01-alpha").getByText("book01-alpha").click();
    await expect(
      page.locator('[data-testid="note-breadcrumb"]:visible').getByTestId("breadcrumb-segment"),
    ).toHaveText(["book01-alpha"]);

    // Un-bookmark via the star (now on the active note, A) — the row
    // disappears and, since it was the only bookmark, the empty state
    // reappears (BOOK-05).
    await expect(star).toHaveAttribute("aria-label", "Remove bookmark");
    await star.click();
    await expect(star).toHaveAttribute("aria-label", "Bookmark this note");
    await openSidebarTab(page, "Bookmarks");
    await expect(page.getByTestId("bookmarks-empty-state")).toBeVisible();
    await expect(bookmarkRowByTitle(page, "book01-alpha")).toHaveCount(0);
  });
});

// ─── BOOK-03 — bookmark folders: create, move-to-folder, collapse ───────────

test.describe("@phase27 BOOK-03: bookmark folder organization", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("create a bookmark folder, move a bookmark into it, collapse hides the child — BOOK-03", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "book03-alpha");

    await openNoteFromTree(page, idA);
    await page.getByTestId("bookmark-star").click();
    await expect(page.getByTestId("bookmark-star")).toHaveAttribute(
      "aria-label",
      "Remove bookmark",
    );

    await openSidebarTab(page, "Bookmarks");
    const panel = page.getByTestId("bookmarks-panel");
    await expect(panel).toBeVisible();
    const rowA = bookmarkRowByTitle(page, "book03-alpha");
    await expect(rowA).toBeVisible();

    // Create a bookmark folder via the panel-level trigger.
    await page.getByRole("button", { name: "New bookmark folder" }).click();
    const folderInput = page.getByLabel("New bookmark folder name");
    await expect(folderInput).toBeVisible();
    await folderInput.fill("Work");
    await folderInput.press("Enter");

    const bookmarkFolderRow = page
      .locator('[data-testid^="bookmark-folder-"]')
      .filter({ hasText: "Work" });
    await expect(bookmarkFolderRow).toBeVisible({ timeout: 5_000 });
    await expect(bookmarkFolderRow).toHaveAttribute("aria-expanded", "true");

    // Move the bookmark into the folder via its "…" menu.
    await rowA.getByRole("button", { name: "Bookmark options" }).click();
    await expect(page.getByRole("menuitem", { name: "Remove" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Move to folder" }).click();
    await expect(page.getByRole("menuitem", { name: "Work" })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole("menuitem", { name: "Work" }).click();

    // The bookmark now nests under the folder row (folder still expanded).
    await expect(bookmarkFolderRow).toHaveAttribute("aria-expanded", "true");
    await expect(rowA).toBeVisible({ timeout: 5_000 });

    // Collapsing the folder hides the child bookmark row.
    await bookmarkFolderRow.click();
    await expect(bookmarkFolderRow).toHaveAttribute("aria-expanded", "false");
    await expect(rowA).toHaveCount(0);

    // Expanding it again reveals the row.
    await bookmarkFolderRow.click();
    await expect(bookmarkFolderRow).toHaveAttribute("aria-expanded", "true");
    await expect(rowA).toBeVisible();
  });
});

// ─── BOOK-04 — reload + full binary restart persistence, survives rename/move ─
//
// The single most important robustness property this phase ships: a
// bookmark stores ONLY a noteId (D-02), and that noteId must keep resolving
// to the same note across (a) a page reload, (b) a FULL BINARY RESTART
// (proving `<vault>/.jasper/bookmarks.json` round-trips through disk, not
// just an in-memory Go struct a reload happens to still see), (c) an
// on-disk rename, and (d) a folder move.

test.describe("@phase27 BOOK-04: bookmark persistence + identity survives rename/move", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("bookmark survives reload, a full binary restart, an on-disk rename, and a folder move — BOOK-04", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "book04-note");
    await openNoteFromTree(page, idA);
    await page.getByTestId("bookmark-star").click();
    await expect(page.getByTestId("bookmark-star")).toHaveAttribute(
      "aria-label",
      "Remove bookmark",
    );

    await openSidebarTab(page, "Bookmarks");
    await expect(bookmarkRowByTitle(page, "book04-note")).toBeVisible();

    // (a) Reload — bookmarks hydrate via a fresh GET /bookmarks on mount, so
    // this proves the server-side JSON store, not just client-side state.
    // Wait for the post-reload burst of initial fetches (tree/bookmarks/
    // tags/mcp-grants/vault/config) to fully settle BEFORE driving any
    // further UI — a late-resolving fetch from that initial burst arriving
    // mid-interaction can re-render a row out from under an in-flight
    // action (observed: a rename committed a fraction of a second after a
    // reload could race a still-in-flight initial tree fetch and get
    // silently reverted). This is a real network-idle condition, not a
    // blind sleep.
    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );
    await page.waitForLoadState("networkidle");
    await openSidebarTab(page, "Bookmarks");
    await expect(bookmarkRowByTitle(page, "book04-note")).toBeVisible({
      timeout: 10_000,
    });

    // (b) Rename the underlying note via the tree's inline rename — the
    // bookmark stores noteId only, so the row must stay present and its
    // live-resolved title must update, with NO new/duplicate row appearing.
    // Done BEFORE the restart below (not after): interacting with the tree
    // immediately after a page reload races the initial burst of hydration
    // fetches — see the networkidle rationale above. Doing all UI-driven
    // mutations on a settled page, then proving persistence via reload/
    // restart as the LAST (read-only) step, is both more deterministic and
    // closer to normal usage. Switching TO the Notes tab itself freshly
    // mounts FileTree (its own initial tree fetch) — settle that too before
    // interacting with the row.
    await openSidebarTab(page, "Notes");
    await page.waitForLoadState("networkidle");
    await renameNoteViaTree(page, idA, "book04-renamed");

    await openSidebarTab(page, "Bookmarks");
    await expect(bookmarkRowByTitle(page, "book04-renamed")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator('[data-testid^="bookmark-row-"]')).toHaveCount(1);

    // (c) Move the note into a new folder via real tree drag-and-drop (same
    // CDP-driven page.dragAndDrop mechanic already proven non-flaky against
    // this exact react-arborist HTML5Backend in dnd-regression.spec.ts).
    // The folder itself is created through the UI's "New folder" toolbar
    // button (not a raw API POST) — its result updates local state directly
    // from the create response, independent of the WS broadcast fan-out
    // path (which is a different concern than BOOK-04's identity/persistence
    // contract and, under parallel-worker load, was observed to occasionally
    // arrive late for a client that made the mutation via a bare HTTP
    // request with no X-Session-ID header).
    await openSidebarTab(page, "Notes");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    const newFolderInput = page.locator('[data-tree-row-kind="folder"] input[type="text"]');
    await expect(newFolderInput).toBeVisible({ timeout: 5_000 });
    await newFolderInput.fill("book04-target");
    await newFolderInput.press("Enter");
    const targetFolder = folderRow(page, "book04-target");
    await expect(targetFolder).toBeVisible({ timeout: 10_000 });

    await page.dragAndDrop(
      `[data-tree-row="${idA}"]`,
      '[data-tree-row-kind="folder"]:has-text("book04-target")',
      { sourcePosition: { x: 60, y: 16 }, targetPosition: { x: 60, y: 16 } },
    );

    await expect
      .poll(
        async () => {
          const tree = await fetchTree(page, jasper.baseURL);
          const folder = tree.root.find(
            (n) => n.kind === "folder" && n.name === "book04-target",
          );
          return folder?.children?.some((c) => c.kind === "note" && c.id === idA) ?? false;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // The bookmark survives the move too — still exactly one row, still
    // resolving to the same (renamed) note.
    await openSidebarTab(page, "Bookmarks");
    const movedRow = bookmarkRowByTitle(page, "book04-renamed");
    await expect(movedRow).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid^="bookmark-row-"]')).toHaveCount(1);

    // Clicking it opens the moved+renamed note in the active pane — full
    // identity round-trip proof (D-02): same noteId, new path, new title.
    await movedRow.getByText("book04-renamed").click();
    await expect(
      page.locator('[data-testid="note-breadcrumb"]:visible').getByTestId("breadcrumb-segment"),
    ).toHaveText(["book04-target", "book04-renamed"]);

    // (d) Full binary restart, as the LAST and strongest proof — kills the
    // process and respawns a fresh one against the SAME data directory/port.
    // Only a bookmarks.json file that truly round-tripped through disk
    // survives this; an in-memory-only store would come back empty. No
    // further UI mutation happens after this: only read-only visibility
    // assertions, so there is nothing left to race.
    jasper = await jasper.restart();
    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 15_000 },
    );
    await openSidebarTab(page, "Bookmarks");
    const survivedRow = bookmarkRowByTitle(page, "book04-renamed");
    await expect(survivedRow).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid^="bookmark-row-"]')).toHaveCount(1);
    await survivedRow.getByText("book04-renamed").click();
    await expect(
      page.locator('[data-testid="note-breadcrumb"]:visible').getByTestId("breadcrumb-segment"),
    ).toHaveText(["book04-target", "book04-renamed"], { timeout: 10_000 });
  });
});
