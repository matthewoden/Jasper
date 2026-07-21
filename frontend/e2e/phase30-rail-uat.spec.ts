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
 * end-to-end before the tab-row markup exists.
 *
 * TAGS-01 is now a real, passing test (Plan 05): clicks each icon tab,
 * asserts exactly one panel is mounted (role-scoped locators, not just
 * visual visibility), waits for the PUT /vault/workspace persist request,
 * then reloads and re-asserts the same tab survives. TAGS-02 remains
 * test.fixme until Plan 08 lands the two-section Tags tab body — do not
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

  test("TAGS-01: the icon-tab row selects exactly one mounted panel at a time, persisted to workspace.json", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "rail-tabs.md",
      "",
      "# rail-tabs\n\nBody text for the Phase 30 tab-row UAT.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    const tabRow = page.getByTestId("right-rail-tab-row");
    const outlineTab = tabRow.getByRole("button", { name: "Outline" });
    const linkedTab = tabRow.getByRole("button", { name: "Linked mentions" });
    const tagsTab = tabRow.getByRole("button", { name: "Tags" });

    const outlinePanel = page.getByRole("group", { name: "Note outline" });
    const linkedPanel = page.getByRole("region", {
      name: "Notes that link to this note",
    });
    const tagsEmptyState = page.getByText(
      "No tags yet. Type #tagname in any note to add a tag.",
    );

    // Default on first load: Outline tab is active, exactly one panel mounted.
    await expect(outlinePanel).toBeVisible({ timeout: 5_000 });
    await expect(linkedPanel).not.toBeVisible();
    await expect(tagsEmptyState).not.toBeVisible();

    await linkedTab.click();
    await expect(linkedPanel).toBeVisible({ timeout: 5_000 });
    await expect(outlinePanel).not.toBeVisible();
    await expect(tagsEmptyState).not.toBeVisible();

    await outlineTab.click();
    await expect(outlinePanel).toBeVisible({ timeout: 5_000 });
    await expect(linkedPanel).not.toBeVisible();

    const workspacePutP = page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/v1/vault/workspace") &&
        resp.request().method() === "PUT",
      { timeout: 5_000 },
    );
    await tagsTab.click();
    await workspacePutP;
    await expect(tagsEmptyState).toBeVisible({ timeout: 5_000 });
    await expect(outlinePanel).not.toBeVisible();
    await expect(linkedPanel).not.toBeVisible();

    // TAGS-01 persistence: the active tab survives a full page reload,
    // restored from workspace.json on mount (same contract as SORT-03).
    await page.reload();
    await waitForConnected(page);
    await expect(tagsEmptyState).toBeVisible({ timeout: 8_000 });
    await expect(outlinePanel).not.toBeVisible();
    await expect(linkedPanel).not.toBeVisible();
  });

  test.fixme(
    "TAGS-02: the Tags tab shows the active note's tags above the vault tag list, both count-desc ordered with alphabetical ties — filled by Plan 08",
    async () => {},
  );
});
