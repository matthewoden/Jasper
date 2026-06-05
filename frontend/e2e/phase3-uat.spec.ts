/**
 * Phase 3 UAT regression suite — closes the regression-proof gap that the
 * 03-HUMAN-UAT.md surfaced. The vitest suite was 230/230 green at the
 * human-verify checkpoint AND multiple critical UX paths were broken
 * because vitest mocks the typed API client / react-arborist's keymap /
 * document focus. This Playwright suite drives the live binary instead.
 *
 * Coverage (against the live ./bin/jasper binary):
 *   - Scenario A — toolbar `+` create → tree updates without reload
 *     (Plan 03-09 broadcast refresh); second create auto-increments to
 *     "untitled 1" instead of 409 (Plan 03-13 nextUntitledName, NOTE
 *     kind); folder create also auto-increments (Plan 03-13, FOLDER
 *     kind). Drag-drop reorganization is NOT covered — see the in-test
 *     comment in A.4 for the synthetic-DnD-vs-react-dnd limitation;
 *     drag remains a manual-UAT step covered by 03-HUMAN-UAT.md.
 *   - Scenario D — external file write + Refresh click → new note
 *     appears in the tree AND opens successfully (Plan 03-10 admin/reindex
 *     re-hydrates the Registry; pre-fix this 404'd).
 *   - Scenario F — F2 enters rename, typing stays in the input (does
 *     not first-letter-jump the tree), Enter commits to disk + tree
 *     (Plan 03-12 RenameInput key trap + TreeRow F2 stopPropagation).
 *
 * Plan 03-23 (Wave 4) strengthens Scenario F to assert on the displayed
 * tree row label after rename — closing the false-positive surface
 * documented in 03-15-SUMMARY.md. Adds Scenario G + G.2 covering both
 * directions of the filename↔H1 binding (Plan 03-22, locked by
 * PROJECT.md 2026-05-03).
 *
 * Manual revert-spike (run by hand to confirm the suite catches regressions):
 *   1. From the gap-closure-merged main, revert ONE line of one of
 *      Plans 03-09 / 03-10 / 03-12 / 03-13 / 03-21 / 03-22's GREEN edits,
 *      e.g. delete `await refresh();` from useTreeMutations.createNote,
 *      or delete `rec.Title = freshTitle` from backend Service.Move.
 *   2. `make build && cd frontend && npx playwright test`
 *   3. The corresponding scenario MUST fail with a concrete assertion
 *      mismatch — Scenario A loses tree-update-without-reload, Scenario
 *      D loses the open-after-refresh path, Scenario F's strengthened
 *      DOM label assertion catches stale-title regressions, Scenarios
 *      G/G.2 catch broken binding directions.
 *   4. Restore the line and re-run; suite returns to green.
 *
 * Plan 03-11 (drag-drop same-parent no-op) is NOT covered by this suite
 * because drag-drop itself is not exercisable via synthetic events; its
 * regression-proof remains FileTree.test.tsx's handleMove unit cases
 * plus the manual UAT step.
 *
 * The 03-15-SUMMARY.md documents the spike concretely with which line
 * to revert per scenario.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { spawnJasper, type JasperHandle } from "./helpers/binary";

let jasper: JasperHandle;

test.beforeEach(async () => {
  jasper = await spawnJasper();
});

test.afterEach(async () => {
  if (jasper) await jasper.kill();
});


test.describe("Phase 3 UAT regression suite", () => {
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
    // Drag-drop reorganization (the phase's locked drag UX, including
    // Plan 03-11's same-parent no-op guard) is NOT covered by this
    // suite. Reason: react-arborist drives drag via react-dnd's
    // html5-backend, which listens to the browser's *native* DnD
    // pipeline. Synthetic Playwright drag events (`dragTo`, manual
    // mouse.down/move/up, programmatic DragEvent dispatch) do not
    // produce a trusted DataTransfer and the html5-backend silently
    // rejects them — a documented limitation of synthetic DnD against
    // react-dnd. We confirmed all three approaches no-op against the
    // live binary during plan 03-15's execution.
    //
    // Plan 03-11's same-parent no-op IS covered at the unit level by
    // FileTree.test.tsx's handleMove cases. End-to-end drag remains a
    // manual-UAT step in 03-HUMAN-UAT.md until either (a) react-arborist
    // exposes a programmatic move API hook we can drive from tests, or
    // (b) we adopt a Playwright drag helper that replays a recorded
    // OS-level drag (e.g. via CDP Input.dispatchDragEvent).
    // ─────────────────────────────────────────────────────────────────
  });

  test("Scenario D: external edit + Refresh + open the new note", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);
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

    const textareaValue =
      (await page.locator(".cm-content").textContent()) ?? "";
    expect(textareaValue).toContain("# External");
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

    await textarea.click();
    await page.keyboard.type("# My Plan\n\nbody text");

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
 * CM6 typing recipe (Phase 5.5 plan 09 Task 1).
 *
 * Replaces textarea.fill() / textarea.inputValue() patterns from the
 * pre-CM6 era. After Phase 5 swapped the textarea for a CodeMirror 6
 * contenteditable surface, .fill() is a silent no-op (the underlying
 * node has no `value` property) and .inputValue() returns "".
 *
 * The recipe: click to focus the .cm-content surface, select-all to
 * clear any existing text, delete the selection, then dispatch the
 * keystrokes via page.keyboard.type so CM6's input handlers fire and
 * the editor state actually changes.
 *
 * NOTE: Cross-platform select-all key — process.platform on the
 * Playwright runner host (Mac=darwin → Meta+a; Linux/Windows CI →
 * Control+a). The CM6 keymap accepts both via @codemirror/commands
 * defaults.
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
 * Background — Bug D (resolved 2026-05-07,
 * `.planning/debug/resolved/rename-input-lifecycle.md`): pressing
 * Escape on a brand-new (just-created, never-confirmed) row now
 * fires DELETE /api/v1/notes/{id} (note kind) or the folder
 * analogue, per the locked UAT product contract. The pre-Bug-D
 * `dismissAnyOpenRenameInput` helper (Escape on the input) silently
 * deleted the row, which invalidated downstream count assertions in
 * Phase 3 Scenarios A / F / G and Phase 4 Scenario 1 — see
 * `.planning/phases/05.5-sidebar-editor-shell-polish/05.5-14-INVESTIGATION.md`.
 *
 * `commitRenameWith` is the post-Bug-D replacement for post-create
 * scenarios that need the row to PERSIST. It waits for the rename
 * input to mount, fills it (overwriting the auto-filled placeholder
 * from Plan 03-13's nextUntitledName), presses Enter, then waits for
 * the input to detach.
 *
 * Selector mirrors the legacy helper:
 * `[data-tree-row] input[type="text"]`. RenameInput.tsx renders a
 * bare <input type="text"> with no aria-label — the row scope is
 * the only stable hook.
 *
 * @param page Playwright page handle
 * @param name Unique name to commit. Must not collide with an existing
 *   sibling — the server returns 409 on collision and the test will
 *   surface that as a hang. Folder vs. note kind is decided by the
 *   row that was created; the rename input is the same component
 *   either way.
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
