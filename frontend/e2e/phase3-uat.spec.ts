/**
 * Drives the live binary where the vitest suite mocks the API client,
 * react-arborist's keymap and document focus.
 *
 * Drag-drop is deliberately NOT covered: synthetic events are rejected by
 * react-dnd's html5-backend, so a synthetic version would false-pass. The
 * same-parent no-op is proven in FileTree.test.tsx's handleMove cases, and the
 * gesture itself is a manual step.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { spawnJasper, type JasperHandle } from "./helpers/binary";

let jasper: JasperHandle;
let appHome: string;

test.beforeEach(async () => {
  // Isolate JASPER_APP_HOME per test. Without this, the binary reads the
  // developer's real ~/.jasper/app.json, whose current_vault may point at a
  // deleted vault from a prior run. That stale vault makes GET /vault/current
  // return the wrong vault and destabilizes the WS (it keeps "reconnecting"),
  // so reindex:complete broadcasts never refresh the tree. --vault then
  // correctly seeds current_vault inside this isolated home.
  appHome = mkdtempSync(path.join(tmpdir(), "jasper-phase3-app-"));
  jasper = await spawnJasper({ env: { JASPER_APP_HOME: appHome } });
});

test.afterEach(async () => {
  if (jasper) await jasper.kill();
  if (appHome) rmSync(appHome, { recursive: true, force: true });
});


test.describe("regression suite", () => {
  test("Scenario A: CRUD without manual reload + auto-increment (drag covered manually)", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);
    await waitForTreeRowCount(page, "note", 1);

    await page.getByRole("button", { name: /new note/i }).click();
    await waitForTreeRowCount(page, "note", 2);
    await commitRenameWith(page, "scenario-a-note-1");

    await page.getByRole("button", { name: /new note/i }).click();
    await waitForTreeRowCount(page, "note", 3);
    await commitRenameWith(page, "scenario-a-note-2");

    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    expect(treeResp.status()).toBe(200);
    const treeJson = await treeResp.json();
    expect(countNotes(treeJson)).toBe(3);

    await page.getByRole("button", { name: /new folder/i }).click();
    await commitRenameWith(page, "scenario-a-folder-1");
    await waitForTreeRowCount(page, "folder", 1);

    const treeWithFolderResp = await page.request.get(
      `${jasper.baseURL}/api/v1/tree`,
    );
    expect(treeWithFolderResp.status()).toBe(200);
    expect(countFolders(await treeWithFolderResp.json())).toBe(1);

    // ─────────────────────────────────────────────────────────────────
    // Drag-drop reorganization is NOT covered here. react-arborist drives
    // drag via react-dnd's html5-backend, which requires native DnD events.
    // Synthetic Playwright drag events (dragTo, mouse.down/move/up,
    // programmatic DragEvent dispatch) do not produce a trusted DataTransfer
    // and the html5-backend silently rejects them.
    //
    // Same-parent no-op is covered at the unit level by
    // FileTree.test.tsx's handleMove cases. End-to-end drag remains a
    // manual-UAT step until react-arborist exposes a programmatic move API
    // or Playwright gains CDP Input.dispatchDragEvent support.
    // ─────────────────────────────────────────────────────────────────
  });

  test("Scenario D: external edit + Refresh + open the new note", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await waitForTreeRowCount(page, "note", 1);

    const notesDir = path.join(jasper.dataDir, "notes");
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(
      path.join(notesDir, "external.md"),
      "# External\n\nHello from outside the server.\n",
    );

    await page.getByRole("button", { name: /refresh/i }).click();

    await expect
      .poll(
        async () => findTreeRowByLabelText(page, /external/i, "note"),
        { timeout: 5_000, message: "external.md never appeared in the tree after Refresh" },
      )
      .toBeTruthy();

    const externalRow = await findTreeRowLocatorByLabel(page, /external/i, "note");
    if (!externalRow) {
      throw new Error("external row vanished between poll and click");
    }
    await externalRow.click();

    const textarea = page.getByRole("textbox", { name: /note content/i });
    await expect(textarea).toBeEnabled({ timeout: 5_000 });

    await expect(
      page.getByRole("alert").filter({ hasText: /Could not load note/i }),
    ).toHaveCount(0);

    // v1.2 redesign: the live-preview plugin replaces the ATX HeaderMark ("# ")
    // with a hidden Decoration when the H1 line is off-cursor, so the editor's
    // rendered text no longer contains the literal "# External". The note still
    // opened successfully — assert on the body line (unique to external.md),
    // which live preview renders verbatim, to prove the correct content loaded
    // (the original regression was a 404 / empty editor). Poll to absorb the
    // CM6 mount/render race.
    await expect
      .poll(
        async () => (await page.locator(".cm-content").textContent()) ?? "",
        {
          timeout: 5_000,
          message: "external.md content never rendered in the editor",
        },
      )
      .toContain("Hello from outside the server.");
  });

  test("Scenario F: F2 enters rename, typing trapped, Enter commits", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);

    await page.getByRole("button", { name: /new note/i }).click();
    await commitRenameWith(page, "scenario-f-setup");

    await waitForTreeRowCount(page, "note", 2);
    const untitledRow = await findTreeRowLocatorByLabel(page, /scenario-f-setup/i, "note");
    if (!untitledRow) {
      throw new Error("scenario-f-setup row not present after toolbar create + commit");
    }

    await untitledRow.click();
    await untitledRow.focus();
    await untitledRow.press("F2");

    const renameInput = untitledRow.locator('input[type="text"]');
    await expect(renameInput).toBeVisible({ timeout: 2_000 });

    await renameInput.click();
    await renameInput.fill("");
    await page.keyboard.type("renamed");
    await expect(renameInput).toHaveValue("renamed");

    await renameInput.press("Enter");

    await expect(renameInput).toHaveCount(0, { timeout: 5_000 });

    const r = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(treeContainsNoteAtPath(j, "renamed.md")).toBe(true);

    await expect
      .poll(
        async () => {
          const row = await findTreeRowLocatorByLabel(page, /renamed/i, "note");
          return row !== null;
        },
        { timeout: 5_000, message: "tree row label did not update to 'renamed' after rename" },
      )
      .toBe(true);
  });

  test("Scenario G: editor H1 edit drives filename rename + tree label refresh (Direction A)", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);
    await waitForTreeRowCount(page, "note", 1);

    await page.getByRole("button", { name: /new note/i }).click();
    await commitRenameWith(page, "scenario-g-setup");
    await waitForTreeRowCount(page, "note", 2);

    const untitledRow = await findTreeRowLocatorByLabel(page, /scenario-g-setup/i, "note");
    if (!untitledRow) throw new Error("scenario-g-setup row not found after create + commit");
    await untitledRow.click();

    const textarea = page.getByRole("textbox", { name: /note content/i });
    await expect(textarea).toBeEnabled({ timeout: 5_000 });

    // Clicking the role=textbox wrapper does not reliably place the caret in
    // CM6's contenteditable, so typed text never reaches the saved doc. Use the
    // .cm-content recipe (focus + select-all + clear + type) so the H1 is
    // actually rewritten to "My Plan" and the H1→filename binding fires.
    await typeIntoEditor(page, "# My Plan\n\nbody text");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");

    await page.waitForTimeout(4_000);

    await expect
      .poll(
        async () => {
          const row = await findTreeRowLocatorByLabel(page, /my plan/i, "note");
          return row !== null;
        },
        { timeout: 5_000, message: "tree label did not refresh to 'My Plan' after H1 edit" },
      )
      .toBe(true);

    const r = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    const j = await r.json();
    const myPlanNote = findNoteByTitleInsensitive(j, /my plan/i);
    expect(myPlanNote).toBeTruthy();

    expect(treeContainsNoteAtPath(j, "scenario-g-setup.md")).toBe(false);
  });

  test("Scenario G.2: tree rename rewrites first H1 in content (Direction B)", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);
    await waitForTreeRowCount(page, "note", 1);

    const scratchpadRow = page.locator('[data-tree-row-kind="note"]').first();
    await scratchpadRow.click();
    const textarea = page.getByRole("textbox", { name: /note content/i });
    await expect(textarea).toBeEnabled({ timeout: 5_000 });
    await typeIntoEditor(page, "# Old Title\n\nbody");
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(500);

    await scratchpadRow.click();
    await page.waitForTimeout(200);
    await scratchpadRow.focus();
    await scratchpadRow.press("F2");

    const renameInput = scratchpadRow.locator('input[type="text"]');
    await expect(renameInput).toBeVisible({ timeout: 2_000 });
    await renameInput.click();
    await renameInput.fill("");
    await page.keyboard.type("New Name");
    await renameInput.press("Enter");

    await page.waitForTimeout(2_000);

    await expect
      .poll(
        async () => {
          const row = await findTreeRowLocatorByLabel(page, /new name/i, "note");
          return row !== null;
        },
        { timeout: 5_000, message: "tree label did not update to 'New Name'" },
      )
      .toBe(true);

    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    const tree = await treeResp.json();
    const renamedNote = findNoteByTitleInsensitive(tree, /new name/i);
    expect(renamedNote).toBeTruthy();
    const noteResp = await page.request.get(
      `${jasper.baseURL}/api/v1/notes/${(renamedNote as { id: string }).id}`,
    );
    const noteJson = await noteResp.json();
    expect(noteJson.content).toMatch(/^# New Name/m);
  });
});


async function waitForTreeRowCount(
  page: Page,
  kind: "note" | "folder",
  expected: number,
): Promise<void> {
  const rows = page.locator(`[data-tree-row-kind="${kind}"]`);
  await expect(rows).toHaveCount(expected, { timeout: 10_000 });
}

/**
 * Wait for the WebSocket to reach "connected". Until then the SaveIndicator is
 * "paused", and clicking Refresh only forces a WS reconnect instead of running
 * a reindex — so the external-edit/H1-rename flows (which depend on a live WS
 * broadcast to refresh the tree) must not start before the socket is up.
 */
async function waitForConnected(page: Page): Promise<void> {
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 15_000 },
  );
}

/**
 * CM6 typing recipe: click .cm-content to focus, select-all to clear
 * existing text, delete the selection, then type via page.keyboard.type
 * so CM6's input handlers fire.
 *
 * .fill() is a silent no-op on .cm-content (contenteditable, not textarea).
 *
 * Cross-platform select-all: process.platform on the Playwright runner host
 * (darwin → Meta+a; Linux/Windows CI → Control+a). CM6 accepts both via
 * @codemirror/commands defaults.
 */
async function typeIntoEditor(page: Page, text: string): Promise<void> {
  const cm = page.locator(".cm-content");
  await cm.click();
  const selectAllKey =
    process.platform === "darwin" ? "Meta+a" : "Control+a";
  await page.keyboard.press(selectAllKey);
  await page.keyboard.press("Delete");
  await page.keyboard.type(text);
}

/**
 * Commit an open rename input with a specific name.
 *
 * Pressing Escape on a brand-new (never-confirmed) row fires DELETE —
 * always use Enter to commit so the row persists.
 *
 * RenameInput.tsx renders a bare <input type="text"> with no aria-label;
 * `[data-tree-row] input[type="text"]` is the only stable selector.
 *
 * @param page Playwright page handle
 * @param name Unique name to commit. Must not collide with an existing
 *   sibling — the server returns 409 on collision.
 */
async function commitRenameWith(
  page: Page,
  name: string,
  timeoutMs = 2_000,
): Promise<void> {
  const renameInput = page
    .locator('[data-tree-row] input[type="text"]')
    .first();
  await renameInput.waitFor({ state: "visible", timeout: timeoutMs });
  await renameInput.fill(name);
  await renameInput.press("Enter");
  await expect(renameInput).toHaveCount(0, { timeout: timeoutMs });
}

async function findTreeRowLocatorByLabel(
  page: Page,
  pattern: RegExp,
  kind: "note" | "folder",
): Promise<Locator | null> {
  const rows = page.locator(`[data-tree-row-kind="${kind}"]`);
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const labelLoc = row.locator("[data-tree-row-label]");
    if ((await labelLoc.count()) === 0) continue;
    const label = await labelLoc.textContent();
    if (label && pattern.test(label)) {
      return row;
    }
  }
  return null;
}

async function findTreeRowByLabelText(
  page: Page,
  pattern: RegExp,
  kind: "note" | "folder",
): Promise<boolean> {
  const row = await findTreeRowLocatorByLabel(page, pattern, kind);
  return row !== null;
}


function countNotes(tree: unknown): number {
  let n = 0;
  const visit = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      const k = (node as { kind?: string }).kind;
      if (k === "note") n++;
      if (k === "folder") visit((node as { children?: unknown }).children);
    }
  };
  visit((tree as { root?: unknown }).root);
  return n;
}

function countFolders(tree: unknown): number {
  let n = 0;
  const visit = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      const k = (node as { kind?: string }).kind;
      if (k === "folder") {
        n++;
        visit((node as { children?: unknown }).children);
      }
    }
  };
  visit((tree as { root?: unknown }).root);
  return n;
}

function treeContainsNoteAtPath(tree: unknown, targetPath: string): boolean {
  let found = false;
  const visit = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      const obj = node as { kind?: string; path?: string; children?: unknown };
      if (obj.kind === "note" && obj.path === targetPath) found = true;
      if (obj.kind === "folder") visit(obj.children);
    }
  };
  visit((tree as { root?: unknown }).root);
  return found;
}

function findNoteByTitleInsensitive(
  tree: unknown,
  pattern: RegExp,
): { id: string; path: string; title: string } | null {
  let found: { id: string; path: string; title: string } | null = null;
  const visit = (nodes: unknown) => {
    if (found || !Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      const obj = node as {
        kind?: string;
        id?: string;
        path?: string;
        title?: string;
        children?: unknown;
      };
      if (obj.kind === "note" && obj.title && pattern.test(obj.title)) {
        found = { id: obj.id!, path: obj.path!, title: obj.title };
        return;
      }
      if (obj.kind === "folder") visit(obj.children);
    }
  };
  visit((tree as { root?: unknown }).root);
  return found;
}
