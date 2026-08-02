/**
 * All tests share ONE spawned binary/vault, but each Playwright test gets a fresh
 * browser context, so client-side pane-layout state starts empty per test.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected, apiCreateNote } from "./helpers/phase7Helpers";
import { openNoteFromTree, noteRow } from "./helpers/openNoteFromTree";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

const LOCKED_ORDER = [
  "Rename",
  "Move to…",
  "Bookmark",
  "Split right",
  "Split down",
  "Find",
  "Replace",
  "Reveal in navigation",
  "Show in file manager",
  "Delete",
];

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

function leafPanes(page: Page): Locator {
  return page.locator('[data-testid="leaf-pane"]');
}

function activeLeafPane(page: Page): Locator {
  return page.locator('[data-testid="leaf-pane"][data-active-pane="true"]');
}

/** The active pane's own note-options (3-dot) trigger button. */
function noteOptionsTrigger(page: Page): Locator {
  return activeLeafPane(page).getByRole("button", { name: "Note options" });
}

async function openNoteOptionsMenu(page: Page): Promise<Locator> {
  await noteOptionsTrigger(page).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible({ timeout: 5_000 });
  return menu;
}

/**
 * The active pane's editor title element. Mirrors phase28-uat.spec.ts's
 * activeEditorTitle — scoped to the active pane (not just any :visible
 * match) since multiple panes can be simultaneously visible in a split.
 */
function activeEditorTitle(page: Page): Locator {
  return activeLeafPane(page)
    .getByTestId("editor-title-element")
    .and(page.locator(":visible"));
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
    `# ${title}\n\nBody text for the earlier note-options UAT.\n`,
  );
  await openNoteFromTree(page, noteId);
  return noteId;
}

test.describe("@note-options: note-options menu", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("the active pane's breadcrumb renders for an open note", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "note-options-smoke.md",
      "",
      "# note-options-smoke\n\nBody text for the note-options smoke test.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    await expect(page.getByTestId("note-breadcrumb")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("CTX-03: the breadcrumb row's 3-dot note-options button opens the locked item set in order", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteAsTab(page, jasper.baseURL, "note-options-order");

    const menu = await openNoteOptionsMenu(page);
    const items = menu.getByRole("menuitem");
    await expect(items).toHaveCount(LOCKED_ORDER.length);
    await expect(items).toHaveText(LOCKED_ORDER);
  });

  test("CTX-03/WS-06: Split right and Split down each open the note in a new split", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteAsTab(page, jasper.baseURL, "note-options-split");

    await expect(leafPanes(page)).toHaveCount(1);

    await (await openNoteOptionsMenu(page))
      .getByRole("menuitem", { name: "Split right" })
      .click();
    await expect(leafPanes(page)).toHaveCount(2, { timeout: 5_000 });
    await expect(activeEditorTitle(page)).toHaveText("note-options-split", {
      timeout: 5_000,
    });

    await (await openNoteOptionsMenu(page))
      .getByRole("menuitem", { name: "Split down" })
      .click();
    await expect(leafPanes(page)).toHaveCount(3, { timeout: 5_000 });
    await expect(activeEditorTitle(page)).toHaveText("note-options-split", {
      timeout: 5_000,
    });
  });

  test("Move to… opens the fuzzy folder modal; Enter moves the note into the chosen folder", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await apiCreateFolder(page, jasper.baseURL, "note-options-target-folder");
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteAsTab(page, jasper.baseURL, "note-options-move");

    await (await openNoteOptionsMenu(page))
      .getByRole("menuitem", { name: "Move to…" })
      .click();

    const input = page.getByRole("textbox", { name: "Move to folder" });
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("note-options-target-folder");
    await expect(
      page.getByRole("option", { name: "note-options-target-folder" }),
    ).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Enter");

    // The dialog closes on a successful move; the breadcrumb reflects the
    // note's new folder.
    await expect(input).toHaveCount(0, { timeout: 5_000 });
    await expect(
      page.getByTestId("note-breadcrumb").getByText("note-options-target-folder"),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Reveal in navigation switches the left sidebar to Notes and pulses the row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "note-options-reveal.md",
      "",
      "# note-options-reveal\n\nBody text.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    // Switch the left sidebar away from Notes so the reveal action has
    // something real to prove.
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByLabel("Search notes", { exact: true })).toBeVisible({
      timeout: 5_000,
    });

    await (await openNoteOptionsMenu(page))
      .getByRole("menuitem", { name: "Reveal in navigation" })
      .click();

    const row = noteRow(page, noteId);
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row).toHaveClass(/jasper-pulse-target/, { timeout: 5_000 });
  });

  test("Delete opens the shared trash-based confirm dialog", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteAsTab(page, jasper.baseURL, "note-options-delete");

    await (await openNoteOptionsMenu(page))
      .getByRole("menuitem", { name: "Delete" })
      .click();

    await expect(page.getByText("Delete note?")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByText(/will be moved to Trash\. You can restore it from Trash later\./),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Delete note?")).toHaveCount(0, {
      timeout: 5_000,
    });
  });

  test("WS-06: a note ends up in a new split from every entry point — tree menu, tab menu, quick switcher, note-options", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const treeTitle = "ws06-tree-entry";
    const tabTitle = "ws06-tab-entry";
    const qsTitle = "ws06-qs-entry";
    const noteOptsTitle = "ws06-note-options-entry";
    const treeId = await apiCreateNote(
      page,
      jasper.baseURL,
      `${treeTitle}.md`,
      "",
      `# ${treeTitle}\n`,
    );
    void tabTitle; // reserved: the tree-opened note IS the tab used for step 2 below.
    await apiCreateNote(page, jasper.baseURL, `${qsTitle}.md`, "", `# ${qsTitle}\n`);
    await openNoteAsTab(page, jasper.baseURL, noteOptsTitle);

    await expect(leafPanes(page)).toHaveCount(1);

    // 1) Tree menu entry point.
    await noteRow(page, treeId).click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 5_000 });
    await page.getByRole("menuitem", { name: "Open in split" }).click();
    await expect(leafPanes(page)).toHaveCount(2, { timeout: 5_000 });
    await expect(activeEditorTitle(page)).toHaveText(treeTitle, { timeout: 5_000 });

    // 2) Tab-menu entry point — right-click the newly opened tab's own pill.
    const activeTabStrip = activeLeafPane(page).getByTestId("tab-strip");
    await activeTabStrip
      .getByRole("tab")
      .filter({ hasText: treeTitle })
      .click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 5_000 });
    await page.getByRole("menuitem", { name: "Open in split" }).click();
    await expect(leafPanes(page)).toHaveCount(3, { timeout: 5_000 });
    await expect(activeEditorTitle(page)).toHaveText(treeTitle, { timeout: 5_000 });

    // 3) Quick switcher entry point (Cmd/Ctrl+Shift+Enter).
    await page.keyboard.press(`${MOD}+o`);
    const dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    const combobox = dialog.getByRole("combobox");
    await combobox.fill(qsTitle);
    const qsRow = dialog.locator('[data-row-kind="note"]').filter({ hasText: qsTitle });
    await expect(qsRow).toHaveCount(1, { timeout: 5_000 });
    await expect(qsRow).toHaveAttribute("aria-selected", "true");
    // Guard against a focus-steal race from a still-settling sibling pane
    // (a just-split EditorPane's own mount-time autofocus effect) landing
    // between fill() and the keyboard shortcut — poll for the combobox
    // itself holding real DOM focus before sending the chord (memory
    // no-flaky-tests: poll for the eventual condition, not a fixed sleep).
    await expect(combobox).toBeFocused({ timeout: 5_000 });
    await page.keyboard.press(`${MOD}+Shift+Enter`);
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    await expect(leafPanes(page)).toHaveCount(4, { timeout: 5_000 });
    await expect(activeEditorTitle(page)).toHaveText(qsTitle, { timeout: 5_000 });

    // 4) Note-options entry point — the FIRST pane still shows the
    // originally-opened note-options tab (every split above targeted a NEW
    // sibling pane, never the first one). Re-activate it, then split from
    // its own note-options menu.
    const firstPane = page.locator('[data-testid="leaf-pane"]').first();
    await firstPane.click();
    await expect(firstPane).toHaveAttribute("data-active-pane", "true", {
      timeout: 5_000,
    });
    await expect(activeEditorTitle(page)).toHaveText(noteOptsTitle, {
      timeout: 5_000,
    });
    await (await openNoteOptionsMenu(page))
      .getByRole("menuitem", { name: "Split right" })
      .click();
    await expect(leafPanes(page)).toHaveCount(5, { timeout: 5_000 });
    await expect(activeEditorTitle(page)).toHaveText(noteOptsTitle, {
      timeout: 5_000,
    });
  });

  test("the active pane's inset accent cue is present in a split and absent in a single-pane layout", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteAsTab(page, jasper.baseURL, "note-options-cue");

    // Single-pane layout: no cue.
    await expect(leafPanes(page)).toHaveCount(1);
    await expect(activeLeafPane(page)).toHaveCSS("box-shadow", "none");

    // Split: the active pane carries the inset accent box-shadow.
    await (await openNoteOptionsMenu(page))
      .getByRole("menuitem", { name: "Split right" })
      .click();
    await expect(leafPanes(page)).toHaveCount(2, { timeout: 5_000 });
    await expect(activeLeafPane(page)).not.toHaveCSS("box-shadow", "none");
  });
});
