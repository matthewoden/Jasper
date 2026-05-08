/**
 * Duplicate-name regression tests — Bug 5 (file/folder same-name coexistence).
 *
 * These tests verify that a note "untitled.md" and a folder "untitled" can
 * coexist in the same parent without any "already exists" error, and that the
 * new-folder / new-note create flows work correctly when a same-named but
 * different-kind sibling already exists.
 *
 * Root cause (identified 2026-05-08):
 *   handleCommitRename in FileTree.tsx calls moveFolder(path, path) or
 *   moveNote(id, path) when the user presses Enter on the placeholder name
 *   without changing it (isNew=true path in RenameInput). The backend's
 *   MoveDir rejects a same-path move with ErrCycle (400) and MoveFile
 *   rejects it with ErrCaseCollision (409). Both produce an error toast
 *   even though the file is already on disk with the correct name.
 *
 * These tests MUST be run against the real binary (not jsdom) because
 * the bug involves a network round-trip to the backend that vitest mocks
 * away. Lesson learned from DnD regression (commit ec79a91).
 *
 * Test pattern: write RED first (against current code), then fix until GREEN.
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
// Helpers (mirrors dnd-regression.spec.ts conventions)
// ─────────────────────────────────────────────────────────────────────

async function openApp(page: Page): Promise<void> {
  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

async function seedFolder(
  page: Page,
  name: string,
  parentPath = "",
): Promise<string> {
  const resp = await page.request.post(`${jasper.baseURL}/api/v1/folders`, {
    data: { name, parent_path: parentPath },
  });
  expect(resp.status()).toBe(201);
  const body = (await resp.json()) as { path: string };
  return body.path;
}

async function seedNote(
  page: Page,
  title: string,
  parentPath = "",
): Promise<string> {
  const resp = await page.request.post(`${jasper.baseURL}/api/v1/notes`, {
    data: { title, parent_path: parentPath },
  });
  expect(resp.status()).toBe(201);
  const body = (await resp.json()) as { id: string };
  return body.id;
}

async function fetchTree(page: Page): Promise<{
  root: Array<{
    kind: string;
    id?: string;
    path?: string;
    name?: string;
    title?: string;
    children?: Array<{
      kind: string;
      id?: string;
      path?: string;
      name?: string;
      title?: string;
    }>;
  }>;
}> {
  const resp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
  expect(resp.status()).toBe(200);
  return resp.json();
}

// ─────────────────────────────────────────────────────────────────────
// Bug 5a: new folder when same-named note already exists
// ─────────────────────────────────────────────────────────────────────
test.describe("Bug 5a — new folder with same name as existing note", () => {
  /**
   * Scenario:
   *   1. A note "untitled.md" already exists at root.
   *   2. User clicks "New folder" in the sidebar toolbar.
   *   3. The inline rename input should show "untitled" (NOT "untitled 1").
   *   4. User presses Enter to accept the placeholder name.
   *   5. No error toast or inline "Already exists." error should appear.
   *   6. The API tree should contain BOTH "untitled.md" (note) and "untitled" (folder).
   */
  test("new folder placeholder is untitled (not untitled 1) when untitled.md exists", async ({
    page,
  }) => {
    await openApp(page);

    // Seed a note named "untitled" at root.
    await seedNote(page, "untitled");

    // Wait for the tree to reflect it.
    await expect(
      page.locator('[data-tree-row-kind="note"]').filter({ hasText: "untitled" }),
    ).toBeVisible({ timeout: 8_000 });

    // Click the "New folder" toolbar button.
    // The toolbar button's aria-label is "New folder" per SidebarToolbar.tsx.
    await page.getByRole("button", { name: "New folder" }).click();

    // Wait for the inline rename input to appear (the tree enters rename mode).
    const input = page.locator('input[type="text"]');
    await expect(input).toBeVisible({ timeout: 8_000 });

    // Assert: placeholder is "untitled" NOT "untitled 1".
    await expect(input).toHaveValue("untitled");

    // Assert: no inline "Already exists." error on mount.
    await expect(page.locator('[role="alert"]')).not.toBeVisible();

    // Press Enter to accept the placeholder name.
    await input.press("Enter");

    // Give the API call time to resolve.
    await page.waitForTimeout(1_000);

    // Assert: no error toast appeared.
    // The toast container renders role=status items with the error message.
    await expect(page.getByText("That name already exists.")).not.toBeVisible();
    await expect(page.getByText("Something went wrong on the server.")).not.toBeVisible();
    await expect(page.locator('[role="alert"]')).not.toBeVisible();

    // Assert: tree now has BOTH "untitled.md" (note) and "untitled" (folder).
    const tree = await fetchTree(page);
    const untitledNote = tree.root.find(
      (n) => n.kind === "note" && n.title === "untitled",
    );
    const untitledFolder = tree.root.find(
      (n) => n.kind === "folder" && n.name === "untitled",
    );
    expect(untitledNote).toBeTruthy();
    expect(untitledFolder).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bug 5b: new note when same-named folder already exists
// ─────────────────────────────────────────────────────────────────────
test.describe("Bug 5b — new note with same name as existing folder", () => {
  /**
   * Scenario (inverse of 5a):
   *   1. A folder "untitled" already exists at root.
   *   2. User clicks "New note" in the sidebar toolbar.
   *   3. The inline rename input should show "untitled" (NOT "untitled 1").
   *   4. User presses Enter to accept the placeholder name.
   *   5. No error toast or inline error should appear.
   *   6. Both "untitled.md" (note) and "untitled" (folder) exist in the API tree.
   */
  test("new note placeholder is untitled (not untitled 1) when folder untitled exists", async ({
    page,
  }) => {
    await openApp(page);

    // Seed a folder named "untitled" at root.
    await seedFolder(page, "untitled");

    // Wait for the tree to reflect it.
    await expect(
      page.locator('[data-tree-row-kind="folder"]').filter({ hasText: "untitled" }),
    ).toBeVisible({ timeout: 8_000 });

    // Click the "New note" toolbar button.
    await page.getByRole("button", { name: "New note" }).click();

    // Wait for the inline rename input.
    const input = page.locator('input[type="text"]');
    await expect(input).toBeVisible({ timeout: 8_000 });

    // Assert: placeholder is "untitled" NOT "untitled 1".
    await expect(input).toHaveValue("untitled");

    // Assert: no inline "Already exists." error on mount.
    await expect(page.locator('[role="alert"]')).not.toBeVisible();

    // Press Enter to accept the placeholder name.
    await input.press("Enter");

    // Give the API call time to resolve.
    await page.waitForTimeout(1_000);

    // Assert: no error toast appeared.
    await expect(page.getByText("That name already exists.")).not.toBeVisible();
    await expect(page.getByText("Something went wrong on the server.")).not.toBeVisible();
    await expect(page.locator('[role="alert"]')).not.toBeVisible();

    // Assert: tree now has BOTH "untitled" (folder) and "untitled.md" (note).
    const tree = await fetchTree(page);
    const untitledNote = tree.root.find(
      (n) => n.kind === "note" && n.title === "untitled",
    );
    const untitledFolder = tree.root.find(
      (n) => n.kind === "folder" && n.name === "untitled",
    );
    expect(untitledNote).toBeTruthy();
    expect(untitledFolder).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bug 5c: rename validation — folder rename should not collide with note
// ─────────────────────────────────────────────────────────────────────
test.describe("Bug 5c — rename folder to same name as sibling note does not show Already exists", () => {
  /**
   * Scenario:
   *   1. Note "alpha.md" and folder "beta" exist at root.
   *   2. User renames folder "beta" to "alpha".
   *   3. The rename input should NOT show "Already exists." (alpha.md is a note,
   *      not a folder — they can coexist).
   *   4. Committing the rename should succeed.
   *   5. Both "alpha.md" (note) and "alpha" (folder) exist after the rename.
   */
  test("renaming a folder to the same name as a sibling note does not show Already exists", async ({
    page,
  }) => {
    await openApp(page);

    // Seed note "alpha" and folder "beta".
    await seedNote(page, "alpha");
    await seedFolder(page, "beta");

    // Wait for both to appear.
    await expect(
      page.locator('[data-tree-row-kind="note"]').filter({ hasText: "alpha" }),
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      page.locator('[data-tree-row-kind="folder"]').filter({ hasText: "beta" }),
    ).toBeVisible({ timeout: 8_000 });

    // Double-click the "beta" folder row to trigger rename.
    await page
      .locator('[data-tree-row-kind="folder"]')
      .filter({ hasText: "beta" })
      .dblclick();

    // Wait for the inline rename input.
    const input = page.locator('input[type="text"]');
    await expect(input).toBeVisible({ timeout: 8_000 });

    // Type the new name. fill() replaces the entire input value.
    await input.fill("alpha");

    // Assert: no inline "Already exists." error (alpha.md is a note, not a folder).
    await expect(page.locator('[role="alert"]')).not.toBeVisible();

    // Press Enter to commit.
    await input.press("Enter");

    // Give the API call time to resolve.
    await page.waitForTimeout(1_000);

    // Assert: no error toast.
    await expect(page.getByText("That name already exists.")).not.toBeVisible();
    await expect(page.getByText("Something went wrong on the server.")).not.toBeVisible();

    // Assert: tree has both "alpha.md" (note) and "alpha" (folder).
    const tree = await fetchTree(page);
    const alphaNote = tree.root.find(
      (n) => n.kind === "note" && n.title === "alpha",
    );
    const alphaFolder = tree.root.find(
      (n) => n.kind === "folder" && n.name === "alpha",
    );
    expect(alphaNote).toBeTruthy();
    expect(alphaFolder).toBeTruthy();
  });
});
