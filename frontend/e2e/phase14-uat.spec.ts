import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolve the real (symlink-followed, case-canonical) path to a directory.
 * On macOS, node's os.tmpdir() returns /var/folders/... but the actual path
 * after EvalSymlinks is /private/var/folders/... The jasper binary canonicalizes
 * the vault path via vault.Canonicalize (EvalSymlinks + toLower on darwin).
 * We need the same canonical base to look up .trash/ correctly.
 */
function realDataDir(dataDir: string): string {
  try {
    return fs.realpathSync(dataDir).toLowerCase();
  } catch {
    return dataDir.toLowerCase();
  }
}
import { spawnJasper, type JasperHandle } from "./helpers/binary";

let jasper: JasperHandle;

test.beforeAll(async () => {
  jasper = await spawnJasper();
});

test.afterAll(async () => {
  if (jasper) await jasper.kill();
});

/**
 * Navigate to the app and wait for the WebSocket to report "connected".
 */
async function waitForConnected(page: Page): Promise<void> {
  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

/**
 * Create a note via the API. Returns the note's UUID.
 */
async function apiCreateNote(
  page: Page,
  title: string,
  parentPath = "",
): Promise<string> {
  const createResp = await page.request.post(`${jasper.baseURL}/api/v1/notes`, {
    data: { parent_path: parentPath, title },
  });
  if (createResp.status() !== 201) {
    const body = await createResp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateNote: POST returned ${String(createResp.status())} for "${title}": ${body}`,
    );
  }
  const created = (await createResp.json()) as { id: string };
  return created.id;
}

/**
 * Create a folder via the API. Ignores 409 (already exists).
 */
async function apiCreateFolder(
  page: Page,
  name: string,
  parentPath = "",
): Promise<void> {
  const resp = await page.request.post(`${jasper.baseURL}/api/v1/folders`, {
    data: { parent_path: parentPath, name },
  });
  if (resp.status() !== 201 && resp.status() !== 409) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateFolder: POST returned ${String(resp.status())} for "${parentPath}/${name}": ${body}`,
    );
  }
}

/**
 * Delete a tree item (note or folder) via the kebab menu and confirm the
 * dialog. Both single-target variants (note/folder) share the SAME
 * "Delete" confirm-button label per the universal delete-confirm
 * dialog's locked copy — the dialog's TITLE
 * ("Delete note?" / "Delete folder?") is what disambiguates, not the
 * confirm button.
 */
async function deleteViaKebab(
  page: Page,
  rowLocator: ReturnType<Page["locator"]>,
): Promise<void> {
  await expect(rowLocator).toBeVisible({ timeout: 10_000 });

  await rowLocator.hover();
  const kebab = rowLocator.locator("[data-tree-row-kebab]");
  await expect(kebab).toBeVisible({ timeout: 5_000 });
  await kebab.click();

  await page.getByText("Delete", { exact: true }).click({ timeout: 5_000 });

  const confirmBtn = page.getByRole("button", { name: "Delete", exact: true });
  await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
  await confirmBtn.click();
}

/**
 * TRASH-01: Deleting a note via the file tree moves it to .trash/ on disk
 * and removes it from the UI tree.
 */
test.describe("@phase14 TRASH-01: note soft-delete", () => {
  test("delete note → row disappears from tree AND file exists in .trash/ on disk", async ({
    page,
  }) => {
    await waitForConnected(page);

    const title = "trash-e2e-note-01";
    const noteId = await apiCreateNote(page, title);

    const noteRow = page.locator(
      `[data-tree-row="${noteId}"][data-tree-row-kind="note"]`,
    );
    await expect(noteRow).toBeVisible({ timeout: 10_000 });

    await deleteViaKebab(page, noteRow);

    await expect(noteRow).toBeHidden({ timeout: 10_000 });

    const canonDataDir = realDataDir(jasper.dataDir);
    const trashFile = path.join(canonDataDir, ".trash", `${title}.md`);
    await expect
      .poll(
        () => fs.existsSync(trashFile),
        { message: `Expected ${trashFile} to exist in .trash/`, timeout: 10_000 },
      )
      .toBe(true);
  });
});

/**
 * TRASH-02: Deleting a folder moves the entire subtree to .trash/ on disk
 * and removes the folder from the UI tree.
 */
test.describe("@phase14 TRASH-02: folder soft-delete", () => {
  test("delete folder → folder row disappears AND subtree present under .trash/<folder>/ on disk", async ({
    page,
  }) => {
    await waitForConnected(page);

    const folderName = "trash-e2e-folder-01";
    await apiCreateFolder(page, folderName);
    const noteTitle = "inside-note";
    await apiCreateNote(page, noteTitle, folderName);

    const folderRow = page
      .locator(`[data-tree-row-kind="folder"]`)
      .filter({ hasText: folderName });
    await expect(folderRow).toBeVisible({ timeout: 10_000 });

    await folderRow.click();

    await deleteViaKebab(page, folderRow);

    await expect(folderRow).toBeHidden({ timeout: 10_000 });

    const canonDataDir = realDataDir(jasper.dataDir);
    const trashFolder = path.join(canonDataDir, ".trash", folderName);
    await expect
      .poll(
        () => fs.existsSync(trashFolder),
        {
          message: `Expected ${trashFolder} directory to exist in .trash/`,
          timeout: 10_000,
        },
      )
      .toBe(true);

    const trashNote = path.join(trashFolder, `${noteTitle}.md`);
    await expect
      .poll(
        () => fs.existsSync(trashNote),
        {
          message: `Expected ${trashNote} to exist inside .trash/${folderName}/`,
          timeout: 5_000,
        },
      )
      .toBe(true);
  });
});
