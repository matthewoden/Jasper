/**
 * Phase 30 UAT — Right-Rail Tags & Context Menus: note-options menu
 * (CTX-03, WS-06 note-options-split entry point, active-pane cue).
 *
 * Wave-0 scaffold (Plan 30-03) — this file is the substrate Plan 09 fills
 * in Wave 3:
 *   CTX-03  Each pane's breadcrumb row grows a 3-dot note-options button
 *           opening: Rename, Move to…, Bookmark/Remove bookmark, Split
 *           right, Split down, Find, Replace, Reveal in navigation, Show
 *           in file manager, Delete (locked order, UI-SPEC §5).
 *   WS-06   "Split right"/"Split down" open the note in a new split from
 *           the note-options entry point.
 * Both -> filled by Plan 09 (see 30-09-PLAN.md files_modified: this file
 * + NoteOptionsMenu.tsx + MoveToFolderModal.tsx + EditorPane.tsx).
 *
 * The smoke assertion below is a REAL, currently-passing check: the
 * shipped per-pane breadcrumb (`[data-testid="note-breadcrumb"]`) already
 * renders for any open note. It proves the Wave-0 harness (spawn + tree
 * open) works end-to-end before the 3-dot note-options trigger exists.
 * The CTX-03/WS-06 cases are test.fixme until Plan 09 lands — do not
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
import { openNoteFromTree } from "./helpers/openNoteFromTree";

test.describe("@note-options Phase 30: note-options menu", () => {
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
      "# note-options-smoke\n\nBody text for the Phase 30 Wave-0 note-options smoke test.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    await expect(page.getByTestId("note-breadcrumb")).toBeVisible({
      timeout: 5_000,
    });
  });

  test.fixme(
    "CTX-03: the breadcrumb row's 3-dot note-options button opens Rename, Move to…, Bookmark, Split right, Split down, Find, Replace, Reveal in navigation, Show in file manager, Delete in locked order — filled by Plan 09",
    async () => {},
  );

  test.fixme(
    "CTX-03/WS-06: Split right/Split down open the note in a new split from the note-options menu — filled by Plan 09",
    async () => {},
  );
});
