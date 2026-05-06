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

// ─────────────────────────────────────────────────────────────────────
// Test cases — each scenario is named so a future failure is self-
// describing in CI logs ("Scenario A: …" not just "test 1").
// ─────────────────────────────────────────────────────────────────────

test.describe("Phase 3 UAT regression suite", () => {
  test("Scenario A: CRUD without manual reload + auto-increment (drag covered manually)", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);
    // Sidebar should mount and show the seeded scratchpad note as a tree row
    // BEFORE any user interaction. Plan 03-09 broadcast-refresh requires
    // the tree to load on mount.
    await waitForTreeRowCount(page, "note", 1);

    // A.1: click the toolbar `+` (New note). Plan 03-09's auto-refresh
    // contract means the new row appears WITHOUT a manual reload.
    await page.getByRole("button", { name: /new note/i }).click();
    // Note count goes from 1 (scratchpad) → 2 (scratchpad + new untitled).
    await waitForTreeRowCount(page, "note", 2);
    // The new note enters inline-rename mode immediately (Plan 03-07 +
    // 03-13 contract). Wait for the input to actually mount (race-safe),
    // then press Escape via the input itself.
    await dismissAnyOpenRenameInput(page);

    // A.2: click `+` again. Plan 03-13's nextUntitledName produces
    // `untitled 1` (or whatever the next free slot is) — the server
    // must NOT 409. Note count → 3.
    await page.getByRole("button", { name: /new note/i }).click();
    await waitForTreeRowCount(page, "note", 3);
    await dismissAnyOpenRenameInput(page);

    // A.3: GET /api/v1/tree directly to verify the server agrees with
    // the UI count (no UI optimism deceiving us).
    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    expect(treeResp.status()).toBe(200);
    const treeJson = await treeResp.json();
    expect(countNotes(treeJson)).toBe(3);

    // A.4: create a folder via the toolbar. This exercises Plan 03-13's
    // nextUntitledName for the FOLDER kind (separate from the NOTE-kind
    // path tested in A.2): a fresh folder named "untitled" must be
    // auto-allocated, and the create must re-render the tree without
    // reload (Plan 03-09 broadcast-refresh).
    await page.getByRole("button", { name: /new folder/i }).click();
    await dismissAnyOpenRenameInput(page);
    await waitForTreeRowCount(page, "folder", 1);

    // The server agrees on the folder count without us issuing a
    // refresh — Plan 03-09's contract.
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

    // D.1: write a new file directly to the data dir's notes/ subdir,
    // outside the server's mutation pipeline. Plan 03-10 ensures the
    // subsequent /admin/reindex re-hydrates the Registry so the freshly-
    // minted UUID is reachable via GET /notes/{id}.
    const notesDir = path.join(jasper.dataDir, "notes");
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(
      path.join(notesDir, "external.md"),
      "# External\n\nHello from outside the server.\n",
    );

    // D.2: click the Refresh button → Sidebar.handleRefresh →
    // POST /admin/reindex (incremental) + useFileTree.refresh().
    await page.getByRole("button", { name: /refresh/i }).click();

    // D.3: external.md should appear in the tree. We match by label
    // since data-tree-row carries the UUID, not the filename. The
    // server's H1 → title extraction yields "External" from "# External".
    await expect
      .poll(
        async () => findTreeRowByLabelText(page, /external/i, "note"),
        { timeout: 5_000, message: "external.md never appeared in the tree after Refresh" },
      )
      .toBeTruthy();

    // D.4: click external.md to open it. Plan 03-10 ensures the
    // registry was re-hydrated, so this should NOT produce the 404
    // that the UAT D.2 surfaced. The textarea should populate.
    const externalRow = await findTreeRowLocatorByLabel(page, /external/i, "note");
    if (!externalRow) {
      throw new Error("external row vanished between poll and click");
    }
    await externalRow.click();

    // The error alert from EditorPane (LOAD_ERROR_COPY) MUST NOT appear.
    // Wait for the load to complete by waiting for the textarea to
    // become enabled (loadStatus="loaded" disables the disabled prop).
    const textarea = page.getByRole("textbox", { name: /note content/i });
    await expect(textarea).toBeEnabled({ timeout: 5_000 });

    // No load-error alert anywhere on the page.
    await expect(
      page.getByRole("alert").filter({ hasText: /Could not load note/i }),
    ).toHaveCount(0);

    // The textarea should contain the file's content.
    const textareaValue = await textarea.inputValue();
    expect(textareaValue).toContain("# External");
  });

  test("Scenario F: F2 enters rename, typing trapped, Enter commits", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);

    // To test F2 + key trap on a note, create one (the seeded
    // scratchpad's name is fine for renaming, but using a freshly-
    // created `untitled` note avoids depending on the seed name).
    await page.getByRole("button", { name: /new note/i }).click();
    // The new note enters rename immediately; cancel that initial rename
    // so we can drive the F2 path explicitly.
    await dismissAnyOpenRenameInput(page);

    // Locate the freshly-created untitled row.
    await waitForTreeRowCount(page, "note", 2);
    const untitledRow = await findTreeRowLocatorByLabel(page, /untitled/i, "note");
    if (!untitledRow) {
      throw new Error("untitled row not present after toolbar create");
    }

    // F.1: focus the row + press F2. Plan 03-12 ensures F2 reaches the
    // row's onKeyDown without arborist swallowing it.
    //
    // The row div carries `tabIndex={0}` and `role="treeitem"`; we use
    // locator-scoped `.press()` so the keystroke lands on the row's
    // own DOM node rather than wherever document.activeElement happens
    // to be after `click()`. Without this, Playwright sometimes
    // dispatches the F2 to the document body (or to react-arborist's
    // outer tree container), which the row never sees.
    await untitledRow.click();
    await untitledRow.focus();
    await untitledRow.press("F2");

    // The inline-rename input mounts inside the row.
    const renameInput = untitledRow.locator('input[type="text"]');
    await expect(renameInput).toBeVisible({ timeout: 2_000 });

    // F.2: typing alphanumeric must INSERT into the input — NOT
    // navigate the tree. Pre-fix, typing "T" or any letter jumped to a
    // folder (first-letter-jump). With Plan 03-12's stopPropagation,
    // the input owns the keystroke.
    //
    // Why we explicitly click the input first: when the new note enters
    // rename via F2, react re-renders the row to swap label → input;
    // RenameInput.useEffect calls inputRef.current.focus()+.select() on
    // mount, but the EditorPane loads the active note in parallel and
    // its own useEffect re-focuses the textarea once loadStatus flips
    // to "loaded". Whichever effect runs last wins. We click the input
    // directly so DOM focus is unambiguous before page.keyboard.type
    // dispatches keys to document.activeElement.
    await renameInput.click();
    await renameInput.fill(""); // clear current value
    await page.keyboard.type("renamed");
    await expect(renameInput).toHaveValue("renamed");

    // F.3: Enter commits. Plan 03-12 ensures Enter does not bubble to
    // arborist's tree-Enter handler. Send Enter scoped to the input so
    // it is unambiguous which element receives the key.
    await renameInput.press("Enter");

    // After the commit, the rename input must be gone (RenameInput
    // unmounts when useTreeStore.endRename() runs in handleCommitRename's
    // success branch). This proves the rename committed without error
    // — a server-side failure would re-render the input with an inline
    // error banner (RenameInput catches TreeMutationError and stays
    // mounted).
    await expect(renameInput).toHaveCount(0, { timeout: 5_000 });

    // After Plan 03-22's bidirectional binding ships, the displayed
    // label MUST follow the rename — Direction B rewrites the H1 to
    // match the new basename, AND Plan 03-21's server-side title
    // refresh in Service.Move ensures GET /tree returns the fresh title.
    // (Pre-Plan-03-22, the assertion below would have been a false
    // positive — we asserted on the wire path, not on the user-
    // perceived label. See 03-HUMAN-UAT-ROUND2.md line 26.)
    const r = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(treeContainsNoteAtPath(j, "renamed.md")).toBe(true);

    // Strengthening per Plan 03-23: assert the displayed tree row label
    // matches the new name. Pre-binding this would have failed; after
    // Plan 03-22 + Plan 03-21 it passes.
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

    // Create a fresh untitled note via the toolbar.
    await page.getByRole("button", { name: /new note/i }).click();
    await dismissAnyOpenRenameInput(page);
    await waitForTreeRowCount(page, "note", 2);

    // Click the new untitled row to open it in the editor.
    const untitledRow = await findTreeRowLocatorByLabel(page, /untitled/i, "note");
    if (!untitledRow) throw new Error("untitled row not found after create");
    await untitledRow.click();

    // Wait for the editor to load (textarea enabled).
    const textarea = page.getByRole("textbox", { name: /note content/i });
    await expect(textarea).toBeEnabled({ timeout: 5_000 });

    // Type an H1 as the first line. This drives Direction A.
    await textarea.click();
    await page.keyboard.type("# My Plan\n\nbody text");

    // Wait for the autosave debounce (2s) PLUS a margin so the move
    // resolves and the tree refreshes.
    await page.waitForTimeout(4_000);

    // The tree row label should now read "My Plan".
    await expect
      .poll(
        async () => {
          const row = await findTreeRowLocatorByLabel(page, /my plan/i, "note");
          return row !== null;
        },
        { timeout: 5_000, message: "tree label did not refresh to 'My Plan' after H1 edit" },
      )
      .toBe(true);

    // The server-side wire path should reflect the new filename.
    // Note: the EXACT path depends on server canonicalization (NFC +
    // lowercase + spaces preserved). We accept either "my plan.md" or
    // "my-plan.md" — match the path of any note in the tree whose
    // title contains "my plan" (case-insensitive).
    const r = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    const j = await r.json();
    const myPlanNote = findNoteByTitleInsensitive(j, /my plan/i);
    expect(myPlanNote).toBeTruthy();

    // The original "untitled.md" should no longer be in the tree
    // (it was renamed away by Direction A).
    expect(treeContainsNoteAtPath(j, "untitled.md")).toBe(false);
  });

  test("Scenario G.2: tree rename rewrites first H1 in content (Direction B)", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);
    await waitForTreeRowCount(page, "note", 1);

    // Seed a note with an H1 directly via the editor. Use the existing
    // scratchpad row as the target; fill it with `# Old Title\n\nbody`
    // and flush via Cmd+S so we don't need to wait on autosave.
    const scratchpadRow = page.locator('[data-tree-row-kind="note"]').first();
    await scratchpadRow.click();
    const textarea = page.getByRole("textbox", { name: /note content/i });
    await expect(textarea).toBeEnabled({ timeout: 5_000 });
    await textarea.fill("# Old Title\n\nbody");
    // Cmd+S to flush immediately (avoid waiting on autosave).
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(500); // let save settle

    // F2 to enter rename mode. We use F2 (verified working in Scenario F)
    // rather than right-click → context menu → "Rename" because Radix's
    // ContextMenu role surface is finicky in synthetic events; F2 lands
    // the same RenameInput surface and is the documented keyboard path
    // (UI-SPEC §Surface 3 + Plan 03-12 binding).
    //
    // Note: we click the row again BEFORE the rename to refresh
    // useTreeStore.selectedRow (Plan 03-20 doc-level F2 routing —
    // selectedRow is read at F2-fire time). The intermediate Cmd+S
    // didn't change selection, but scrolling / focus shifts may have.
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

    // Wait for the move + H1 rewrite + content update + tree refresh.
    await page.waitForTimeout(2_000);

    // The tree row label is "New Name".
    await expect
      .poll(
        async () => {
          const row = await findTreeRowLocatorByLabel(page, /new name/i, "note");
          return row !== null;
        },
        { timeout: 5_000, message: "tree label did not update to 'New Name'" },
      )
      .toBe(true);

    // The file content's first H1 has been rewritten.
    // Re-load the note's content via the API and inspect.
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

// ─────────────────────────────────────────────────────────────────────
// Helpers — DOM + JSON walkers. Kept in this file so the spec stays
// self-contained; if future scenarios need these, lift to a sibling
// module under e2e/helpers/.
// ─────────────────────────────────────────────────────────────────────

async function waitForTreeRowCount(
  page: Page,
  kind: "note" | "folder",
  expected: number,
): Promise<void> {
  const rows = page.locator(`[data-tree-row-kind="${kind}"]`);
  await expect(rows).toHaveCount(expected, { timeout: 10_000 });
}

/**
 * Wait for any inline-rename input in the tree to mount, then dismiss it
 * via Escape *on the input itself*. After a toolbar `+` create the new
 * row enters rename mode (Plan 03-13 + 03-07 contract); a bare
 * `page.keyboard.press("Escape")` before the input mounts goes nowhere
 * useful and leaves the row stuck in rename. Race-safe: if no input is
 * mounted within `timeoutMs`, returns silently (caller's subsequent
 * assertion will surface any real bug).
 */
async function dismissAnyOpenRenameInput(
  page: Page,
  timeoutMs = 2_000,
): Promise<void> {
  const renameInput = page
    .locator('[data-tree-row] input[type="text"]')
    .first();
  try {
    await renameInput.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return; // no rename input is open — nothing to dismiss
  }
  await renameInput.press("Escape");
  await expect(renameInput).toHaveCount(0, { timeout: 2_000 });
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
    // A row in rename mode renders <RenameInput> instead of the static
    // <span data-tree-row-label>. Skip those rows rather than blocking
    // on a textContent that will never resolve.
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

// We deliberately avoid importing the frontend's typed Tree shape so this
// E2E suite stays at the JSON boundary — mirroring backend/cmd/jasper/
// smoke_test.go's "test the wire format" pattern.

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
