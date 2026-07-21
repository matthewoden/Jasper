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
 * TAGS-01 is a real, passing test (Plan 05): clicks each icon tab,
 * asserts exactly one panel is mounted (role-scoped locators, not just
 * visual visibility), waits for the PUT /vault/workspace persist request,
 * then reloads and re-asserts the same tab survives. Its Tags-tab empty
 * state locator uses the LOWER (vault-wide) section's "No tags in this
 * vault" copy (D-10, mock-literal — replaces the pre-Plan-08 "No tags
 * yet..." copy) since Plan 08 upgraded the Tags tab to two sections.
 *
 * TAGS-02 (Plan 08) is now a real, passing test: opens a tagless note,
 * asserts the upper section's "No tags on this note" empty state, types
 * `#livetag` into the live CM6 doc and asserts the chip appears in the
 * upper section without a save round-trip (D-08 live parse), then clicks
 * the chip and asserts the left sidebar switches to the Search panel with
 * a `tag:livetag` query seeded (D-07).
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
    const tagsEmptyState = page.getByText("No tags in this vault");

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

  test("TAGS-02: the Tags tab shows the active note's live tags above the vault tag list; a chip click seeds a tag: search query", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "rail-tags-live.md",
      "",
      "# rail-tags-live\n\nBody text for the Phase 30 TAGS-02 UAT.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    const tabRow = page.getByTestId("right-rail-tab-row");
    await tabRow.getByRole("button", { name: "Tags" }).click();

    // Two sections: upper "Note tags" sub-header, lower "Tags" sub-header,
    // both mounted at once (D-06) — unlike Outline/Linked mentions,
    // which are exclusive with Tags.
    await expect(page.getByText("Note tags")).toBeVisible({ timeout: 5_000 });

    // Upper section empty state: this note has no tags yet.
    const noteTagsEmptyState = page.getByText("No tags on this note");
    await expect(noteTagsEmptyState).toBeVisible({ timeout: 5_000 });

    // Live-parse (D-08): typing #livetag in the editor shows a chip in the
    // upper section immediately — no save round-trip required.
    const editor = page.locator(".cm-content:visible").first();
    await editor.click();
    const gotoEndKey = process.platform === "darwin" ? "Meta+End" : "Control+End";
    await page.keyboard.press(gotoEndKey);
    await page.keyboard.type(" #livetag");

    const liveTagChip = page.getByTestId("note-tag-chip-livetag");
    await expect(liveTagChip).toBeVisible({ timeout: 5_000 });
    await expect(noteTagsEmptyState).not.toBeVisible();

    // Tag click (D-07): opens the left Search panel seeded with tag:{name}.
    await liveTagChip.click();
    const searchInput = page.getByRole("textbox", { name: "Search notes" });
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
    await expect(searchInput).toHaveValue("tag:livetag");
  });

  test("30-13: the right rail has exactly ONE collapse/reopen control, entirely within its own region, and it persists across reload", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "rail-single-control.md",
      "",
      "# rail-single-control\n\nBody text for the 30-13 single-control UAT.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    // The old tab-bar rail toggle (TABUI-02) was removed in 30-13 — the tab
    // strip must never carry a rail-open/close control, in either state.
    await expect(page.getByTestId("tab-strip-right-cluster")).toHaveCount(0);

    const tabRow = page.getByTestId("right-rail-tab-row");
    await expect(tabRow).toBeVisible({ timeout: 5_000 });

    // Collapse via the rail's OWN control (inner-edge PanelRight button,
    // mirroring SidebarTabRow's collapse button).
    const collapseBtn = tabRow.getByRole("button", { name: "Collapse panels" });
    await expect(collapseBtn).toBeVisible();
    await collapseBtn.click();

    // The full rail unmounts; a slim collapsed strip with exactly ONE
    // reopen control takes its place — never the tab bar.
    await expect(tabRow).toHaveCount(0, { timeout: 5_000 });
    const collapsedStrip = page.getByTestId("right-rail-collapsed");
    await expect(collapsedStrip).toBeVisible({ timeout: 5_000 });
    const reopenBtn = collapsedStrip.getByRole("button", { name: "Show panels" });
    await expect(reopenBtn).toBeVisible();

    // Exactly one "Show panels"/"Collapse panels" affordance exists on the
    // whole page — no duplicate control in the tab bar.
    await expect(
      page.getByRole("button", { name: /show panels|collapse panels/i }),
    ).toHaveCount(1);
    await expect(page.getByTestId("tab-strip-right-cluster")).toHaveCount(0);

    // Reopen via the rail's own control.
    await reopenBtn.click();
    await expect(tabRow).toBeVisible({ timeout: 5_000 });
    await expect(collapsedStrip).toHaveCount(0);

    // Re-collapse, then reload — the collapsed state (and single-control
    // contract) must survive the reload.
    await tabRow.getByRole("button", { name: "Collapse panels" }).click();
    await expect(collapsedStrip).toBeVisible({ timeout: 5_000 });

    await page.reload();
    await waitForConnected(page);
    await expect(page.getByTestId("right-rail-collapsed")).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByTestId("right-rail-tab-row")).toHaveCount(0);
    await expect(page.getByTestId("tab-strip-right-cluster")).toHaveCount(0);

    // Leave the rail expanded for any subsequent test in this file.
    await page
      .getByTestId("right-rail-collapsed")
      .getByRole("button", { name: "Show panels" })
      .click();
    await expect(page.getByTestId("right-rail-tab-row")).toBeVisible({
      timeout: 5_000,
    });
  });
});
