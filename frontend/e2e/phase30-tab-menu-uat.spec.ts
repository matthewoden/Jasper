/**
 * Phase 30 UAT — Right-Rail Tags & Context Menus: tab context menu
 * (CTX-01, WS-06 tab-split entry point, pin drag).
 *
 * Wave-0 scaffold (Plan 30-03) — this file is the substrate Plan 06 fills
 * in Wave 2:
 *   CTX-01  Tab menu adds Close all, Open in split, New note to the
 *           right, Pin/Unpin, Rename, Show in file manager (locked
 *           UI-SPEC §3 order); close-others/to-right/all skip pinned
 *           tabs.
 *   WS-06   "Open in split" opens the tab's note in a new right/row
 *           split.
 * Both -> filled by Plan 06 (see 30-06-PLAN.md files_modified: this file
 * + TabContextMenu.tsx + TabStrip.tsx).
 *
 * The smoke assertion below is a REAL, currently-passing check: the
 * shipped four-item TabContextMenu (New note to the right / Close tab /
 * Close other tabs / Close tabs to the right) already opens on
 * right-click. It proves the Wave-0 harness (spawn + tree open + tab
 * right-click) works end-to-end before the new CTX-01 items exist. The
 * CTX-01/WS-06 + pin-drag cases are test.fixme until Plan 06 lands — do
 * not assert unbuilt behavior as passing.
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) before Playwright — the spec runs against the EMBEDDED binary.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive assertion uses
 * expect/expect.poll (memory no-flaky-tests). Drive drag interactions with
 * real page.mouse (never synthetic DragEvents) per project memory
 * verify-dnd-with-real-mouse once Plan 06 fills the pin-drag case.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected, apiCreateNote } from "./helpers/phase7Helpers";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

function tabStrip(page: Page): Locator {
  return page.getByTestId("tab-strip");
}

/** The tab pill whose visible label matches `title` exactly. */
function tabPill(page: Page, title: string): Locator {
  return tabStrip(page).getByRole("tab").filter({ hasText: title });
}

test.describe("@tab-menu Phase 30: tab context menu", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("right-clicking a tab opens the tab context menu (Close tab item)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const title = "tab-menu-smoke";
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      `${title}.md`,
      "",
      `# ${title}\n\nBody text for the Phase 30 Wave-0 tab-menu smoke test.\n`,
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    await tabPill(page, title).click({ button: "right" });
    await expect(page.getByText("Close tab", { exact: true })).toBeVisible({
      timeout: 5_000,
    });
  });

  test.fixme(
    "CTX-01/WS-06: the menu adds Close all, Open in split, Pin/Unpin, Rename, Show in file manager in locked UI-SPEC §3 order — filled by Plan 06",
    async () => {},
  );

  test.fixme(
    "CTX-01: pinning a tab clamps it left of the divider; close-others/close-to-right/close-all skip pinned tabs (real-mouse drag, 50x non-flake) — filled by Plan 06",
    async () => {},
  );
});
