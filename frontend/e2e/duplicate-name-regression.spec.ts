/**
 * A note "untitled.md" and a folder "untitled" must coexist in the same parent.
 *
 * Must run against the real binary: the bug is a network round-trip (MoveDir
 * rejects a same-path move with ErrCycle, MoveFile with ErrCaseCollision) that
 * vitest mocks away entirely.
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

    await seedNote(page, "untitled");

    await expect(
      page.locator('[data-tree-row-kind="note"]').filter({ hasText: "untitled" }),
    ).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: "New folder" }).click();

    const input = page.locator('input[type="text"]');
    await expect(input).toBeVisible({ timeout: 8_000 });

    await expect(input).toHaveValue("untitled");

    await expect(page.locator('[role="alert"]')).not.toBeVisible();

    await input.press("Enter");

    await page.waitForTimeout(1_000);

    await expect(page.getByText("That name already exists.")).not.toBeVisible();
    await expect(page.getByText("Something went wrong on the server.")).not.toBeVisible();
    await expect(page.locator('[role="alert"]')).not.toBeVisible();

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

    await seedFolder(page, "untitled");

    await expect(
      page.locator('[data-tree-row-kind="folder"]').filter({ hasText: "untitled" }),
    ).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: "New note" }).click();

    const input = page.locator('input[type="text"]');
    await expect(input).toBeVisible({ timeout: 8_000 });

    await expect(input).toHaveValue("untitled");

    await expect(page.locator('[role="alert"]')).not.toBeVisible();

    await input.press("Enter");

    await page.waitForTimeout(1_000);

    await expect(page.getByText("That name already exists.")).not.toBeVisible();
    await expect(page.getByText("Something went wrong on the server.")).not.toBeVisible();
    await expect(page.locator('[role="alert"]')).not.toBeVisible();

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

    await seedNote(page, "alpha");
    await seedFolder(page, "beta");

    await expect(
      page.locator('[data-tree-row-kind="note"]').filter({ hasText: "alpha" }),
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      page.locator('[data-tree-row-kind="folder"]').filter({ hasText: "beta" }),
    ).toBeVisible({ timeout: 8_000 });

    await page
      .locator('[data-tree-row-kind="folder"]')
      .filter({ hasText: "beta" })
      .dblclick();

    const input = page.locator('input[type="text"]');
    await expect(input).toBeVisible({ timeout: 8_000 });

    await input.fill("alpha");

    await expect(page.locator('[role="alert"]')).not.toBeVisible();

    await input.press("Enter");

    await page.waitForTimeout(1_000);

    await expect(page.getByText("That name already exists.")).not.toBeVisible();
    await expect(page.getByText("Something went wrong on the server.")).not.toBeVisible();

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
