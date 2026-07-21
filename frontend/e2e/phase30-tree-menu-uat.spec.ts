/**
 * Phase 30 UAT — Right-Rail Tags & Context Menus: tree row context menu
 * (CTX-02, WS-06 tree-split entry point, bulk menu).
 *
 * Wave-0 scaffold (Plan 30-03) — this file is the substrate Plan 07 fills
 * in Wave 2:
 *   CTX-02  Note-row menu adds Open in split, Bookmark/Remove bookmark;
 *           folder-row menu adds Show in file manager below New folder.
 *   WS-06   "Open in split" opens the row's note in a new right/row
 *           split.
 *   Bulk    A multi-select bulk variant (Open N tabs / Open in split /
 *           Bookmark N notes / Delete N notes) when selectionCount > 1.
 * All -> filled by Plan 07 (see 30-07-PLAN.md files_modified: this file +
 * TreeRowMenu.tsx + FileTree.tsx + TreeRow.tsx + DeleteConfirmDialog.tsx).
 *
 * The smoke assertion below is a REAL, currently-passing check: the
 * shipped note-row menu (Open / New note / Rename / Delete) already opens
 * on right-click. It proves the Wave-0 harness (spawn + tree open +
 * row right-click) works end-to-end before the new CTX-02 items exist.
 * The CTX-02/WS-06/bulk cases are test.fixme until Plan 07 lands — do not
 * assert unbuilt behavior as passing.
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) before Playwright — the spec runs against the EMBEDDED binary.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive assertion uses
 * expect/expect.poll (memory no-flaky-tests).
 */
import { test, expect } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected, apiCreateNote } from "./helpers/phase7Helpers";
import { openNoteFromTree, noteRow } from "./helpers/openNoteFromTree";

test.describe("@tree-menu Phase 30: tree row context menu", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("right-clicking a note row opens the tree row context menu (Rename item)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "tree-menu-smoke.md",
      "",
      "# tree-menu-smoke\n\nBody text for the Phase 30 Wave-0 tree-menu smoke test.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    await noteRow(page, noteId).click({ button: "right" });
    await expect(page.getByText("Rename", { exact: true })).toBeVisible({
      timeout: 5_000,
    });
  });

  test.fixme(
    "CTX-02/WS-06: the note-row menu adds Open in split and Bookmark/Remove bookmark; the folder-row menu adds Show in file manager below New folder — filled by Plan 07",
    async () => {},
  );

  test.fixme(
    "CTX-02: a multi-select bulk menu (Open N tabs / Open in split / Bookmark N notes / Delete N notes) renders when selectionCount > 1 — filled by Plan 07",
    async () => {},
  );
});
