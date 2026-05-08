/**
 * DnD regression tests — Bug A (drag past last row) + Bug B (folder→folder move).
 *
 * These tests verify the fix for bugs that PASSED unit tests but FAILED in
 * the browser in commit ec79a91. All assertions must pass against a real
 * running binary using actual CDP-driven drag events.
 *
 * Background on drag events:
 *   react-arborist uses react-dnd's HTML5Backend which listens for native
 *   browser drag events (dragstart, dragenter, dragover, drop, dragend).
 *   Playwright's page.dragAndDrop() uses CDP Input.dispatchDragEvent on
 *   Chromium which fires the full HTML5 event chain, making it compatible
 *   with react-dnd. The older approach of mouse.down/move/up does NOT
 *   fire these events and was why previous unit tests were insufficient.
 *
 * Seed strategy: each test creates a known tree state via the API so we
 * can assert exact positions. The default vault has one scratchpad note;
 * we add more notes and folders via API before testing.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

let jasper: JasperHandle;

test.beforeEach(async () => {
  jasper = await spawnJasper();
});

test.afterEach(async () => {
  if (jasper) await jasper.kill();
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** Navigate to the app and wait for the connection-status dot to show connected. */
async function openApp(page: Page): Promise<void> {
  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

/** Seed a folder via the API. Returns the folder path. */
async function seedFolder(
  page: Page,
  name: string,
  parentPath = "",
): Promise<string> {
  const resp = await page.request.post(`${jasper.baseURL}/api/v1/folders`, {
    data: { name, parent_path: parentPath },
  });
  expect(resp.status()).toBe(201);
  const body = await resp.json() as { path: string };
  return body.path;
}

/** Seed a note via the API. Returns the note id. */
async function seedNote(
  page: Page,
  title: string,
  parentPath = "",
): Promise<string> {
  const resp = await page.request.post(`${jasper.baseURL}/api/v1/notes`, {
    data: { title, parent_path: parentPath },
  });
  expect(resp.status()).toBe(201);
  const body = await resp.json() as { id: string };
  return body.id;
}

/** Wait for the tree to show the given count of note rows. */
async function waitForNoteCount(page: Page, count: number): Promise<void> {
  await expect(
    page.locator('[data-tree-row-kind="note"]'),
  ).toHaveCount(count, { timeout: 8_000 });
}

/** Wait for the tree to show the given count of folder rows. */
async function waitForFolderCount(page: Page, count: number): Promise<void> {
  await expect(
    page.locator('[data-tree-row-kind="folder"]'),
  ).toHaveCount(count, { timeout: 8_000 });
}

/**
 * Fetch the current tree from the API and return it.
 */
async function fetchTree(page: Page): Promise<{
  root: Array<{
    kind: string;
    id?: string;
    path?: string;
    name?: string;
    title?: string;
    children?: Array<{ kind: string; id?: string; path?: string; name?: string; title?: string }>;
  }>;
}> {
  const resp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
  expect(resp.status()).toBe(200);
  return resp.json();
}

// ─────────────────────────────────────────────────────────────────────
// Bug A: drag past last row → drop at root
// ─────────────────────────────────────────────────────────────────────
test.describe("Bug A regression — drag past last row", () => {
  /**
   * Scenario: a note at root is dragged onto the empty grey area BELOW
   * the last row of the sidebar tree. The note should move to root
   * (which is a no-op for a root note) — but more importantly, the drop
   * must COMPLETE (onMove fires) without being silently discarded.
   *
   * To make the drop observable, we instead drag a note that is INSIDE
   * a folder onto the empty area below the tree. After the drag:
   *   - the note must be at the root (moved out of the folder), OR
   *   - the API reports the note's path as a root-level file
   *
   * Because we can observe the result via the API, we know the drop
   * actually fired. On the broken code, no move happens and the note
   * stays inside the folder.
   */
  test("note dragged below last row moves to root", async ({ page }) => {
    await openApp(page);

    // Seed: create a folder with a note inside it.
    await seedFolder(page, "projects");
    await seedNote(page, "my-note", "projects");

    // Wait for tree to reflect: 1 folder + 2 notes (scratchpad + my-note)
    // but my-note is inside folder so only scratchpad visible at root level.
    await waitForFolderCount(page, 1);
    // react-arborist defaults openByDefault=true, so the projects folder is
    // already open on load — both scratchpad and my-note are visible.
    // (A click would CLOSE the folder, which is the opposite of what we want.)
    await waitForNoteCount(page, 2);
    await waitForFolderCount(page, 1);

    // Locate my-note row.
    const myNoteRow = page.locator('[data-tree-row-kind="note"]').filter({
      hasText: "my-note",
    });
    await expect(myNoteRow).toBeVisible({ timeout: 5_000 });

    // Drag my-note into the empty area of the react-arborist tree container
    // below the last visible row. react-arborist's outer drop hook
    // (useOuterDrop) is registered on the react-window outer container,
    // which covers the empty area below the rows. With height=9999 on the
    // Tree, the outer container is 9999px tall but only a small portion is
    // visible — we target a y position well past the last row (3 rows ×
    // 32px = 96px, so y=200 is safely in the empty area).
    //
    // page.dragAndDrop uses CDP Input.dispatchDragEvent which fires real
    // HTML5 drag events compatible with react-dnd's HTML5Backend.
    await page.dragAndDrop(
      '[data-tree-row-kind="note"]:has-text("my-note")',
      '[role="tree"]',
      {
        sourcePosition: { x: 60, y: 16 },
        targetPosition: { x: 60, y: 200 },
      },
    );

    // Give the move API call time to complete (it's async after drop).
    await page.waitForTimeout(1_000);

    // Verify: my-note should now be at root (path = "my-note.md")
    const tree = await fetchTree(page);
    const noteAtRoot = tree.root.find(
      (n) => n.kind === "note" && (n.path ?? "").endsWith("my-note.md") && !(n.path ?? "").includes("/"),
    );
    expect(noteAtRoot).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bug B regression — folder drag into another folder
// ─────────────────────────────────────────────────────────────────────
test.describe("Bug B regression — folder drag into another folder", () => {
  /**
   * Scenario: two root-level folders exist: "alpha" and "beta".
   * Drag "alpha" onto "beta". After the drag:
   *   - "alpha" should be nested inside "beta" (path = "beta/alpha")
   *   - The tree API confirms the move
   *
   * On the broken code, the drag ghost appears but no drop fires and
   * "alpha" stays at root.
   */
  test("folder dragged into another folder moves correctly", async ({ page }) => {
    await openApp(page);

    // Seed two root-level folders.
    await seedFolder(page, "alpha");
    await seedFolder(page, "beta");

    // Wait for both folders to appear in the tree.
    await waitForFolderCount(page, 2);

    // Locate the folder rows.
    const alphaRow = page.locator('[data-tree-row-kind="folder"]').filter({
      hasText: "alpha",
    });
    const betaRow = page.locator('[data-tree-row-kind="folder"]').filter({
      hasText: "beta",
    });
    await expect(alphaRow).toBeVisible({ timeout: 5_000 });
    await expect(betaRow).toBeVisible({ timeout: 5_000 });

    // Drag alpha ONTO beta's center (hover.inMiddle = true triggers "drop INTO folder").
    // We use page.dragAndDrop with targetPosition pointing to the center of betaRow.
    const betaBox = await betaRow.boundingBox();
    if (!betaBox) throw new Error("Could not get beta bounding box");

    await page.dragAndDrop(
      '[data-tree-row-kind="folder"]:has-text("alpha")',
      '[data-tree-row-kind="folder"]:has-text("beta")',
      {
        // Source: center of alpha row
        sourcePosition: { x: 60, y: 16 },
        // Target: center of beta row (y=16 is middle of 32px row → hover.inMiddle)
        targetPosition: { x: 60, y: 16 },
      },
    );

    // Give the move API call time to complete.
    await page.waitForTimeout(1_500);

    // Verify: alpha should now be inside beta.
    const tree = await fetchTree(page);
    const betaFolder = tree.root.find((n) => n.kind === "folder" && n.name === "beta");
    expect(betaFolder).toBeTruthy();
    const alphaInsideBeta = betaFolder?.children?.find(
      (c) => c.kind === "folder" && c.name === "alpha",
    );
    expect(alphaInsideBeta).toBeTruthy();
  });
});
