/**
 * Phase 30 UAT — Right-Rail Tags & Context Menus: right rail Tags tab
 * (TAGS-01, TAGS-02).
 *
 * Wave-0 scaffold (Plan 30-03) — this file is the substrate feature plans
 * fill in later waves:
 *   TAGS-01  30x30 icon-tab row (Outline / Linked mentions / Tags), one
 *            panel mounted at a time, active tab persisted to
 *            workspace.json.                          -> filled by Plan 05
 *   TAGS-02  Tags tab: active-note tags above the vault tag list,
 *            count-desc ordered, live CM6 doc sync.    -> filled by Plan 08
 *
 * The smoke assertion below is a REAL, currently-passing check: the right
 * rail's <aside> shell + left-edge resize handle, which 30-PATTERNS.md's
 * Plan 05 rewrite explicitly preserves ("Only the outer <aside> shell
 * ... survives"). It proves the Wave-0 harness (spawn + tree open) works
 * end-to-end before the tab-row markup exists. The TAGS-01/02 cases are
 * test.fixme until their owning plans land — do not assert unbuilt
 * behavior as passing.
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

test.describe("@tags-rail Phase 30: right rail Tags tab", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("the right rail shell renders with an open note", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "rail-smoke.md",
      "",
      "# rail-smoke\n\nBody text for the Phase 30 Wave-0 rail smoke test.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    await expect(
      page.getByRole("separator", { name: "Resize backlinks panel" }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test.fixme(
    "TAGS-01: a 30x30 icon-tab row (Outline / Linked mentions / Tags) selects exactly one mounted panel at a time, persisted to workspace.json — filled by Plan 05",
    async () => {},
  );

  test.fixme(
    "TAGS-02: the Tags tab shows the active note's tags above the vault tag list, both count-desc ordered with alphabetical ties — filled by Plan 08",
    async () => {},
  );
});
