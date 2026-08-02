/**
 * Right-rail tab row and Tags panel.
 *
 * The Tags-tab empty-state locator targets the LOWER vault-wide section's copy;
 * the upper active-note section it could otherwise match no longer exists.
 */
import { test, expect } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected, apiCreateNote } from "./helpers/phase7Helpers";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

test.describe("@tags-rail: right rail Tags tab", () => {
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
      "# rail-smoke\n\nBody text for the rail smoke test.\n",
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
      "# rail-tabs\n\nBody text for the earlier tab-row UAT.\n",
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

  test("TAGS-02: the Tags tab is a single vault-wide tag list; a tag click filters the file tree", async ({
    page,
  }) => {
    // A later trim collapsed the earlier two-section Tags tab (an
    // upper active-note "Note tags" live-CM6 section + a lower vault-wide
    // list) into a single vault-wide list — the note-tags concept (and its
    // live-parse machinery, useNoteTagsStore) is fully deleted. This test
    // originally asserted the removed upper section and a "left Search
    // panel with tag: query" that doesn't exist as a distinct UI — the
    // actual (and unchanged) shipped mechanism is activeTagFilter:
    // clicking a tag row filters the file tree and shows the
    // ActiveTagFilterChip ("Filtered by: #name"), same contract phase6-uat
    // S5 already covers for the left-sidebar tag browser.
    await page.setViewportSize({ width: 1512, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "rail-tags-live.md",
      "",
      "# rail-tags-live\n\nBody text with a #livetag for the TAGS-02 UAT.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    const tabRow = page.getByTestId("right-rail-tab-row");
    await tabRow.getByRole("button", { name: "Tags" }).click();

    // Single vault-wide list — no "Note tags" sub-section, no panel header.
    await expect(page.getByText("Note tags")).toHaveCount(0);

    const tagRow = page.getByTestId("tag-row-livetag");
    await expect(tagRow).toBeVisible({ timeout: 5_000 });
    await expect(tagRow).toContainText("#livetag");

    // Tag click (unchanged): sets activeTagFilter, filtering the file
    // tree and surfacing the dismissible "Filtered by: #livetag" chip.
    await tagRow.click();
    const chip = page.locator('[aria-label="Remove tag filter: #livetag"]');
    await expect(chip).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Filtered by:")).toBeVisible();

    await chip.click();
    await expect(chip).toHaveCount(0, { timeout: 5_000 });
  });

  test("260721-cjt: collapsing the right rail leaves the editor flush with the right edge; the rightmost pane's tab bar carries the sole reopen toggle, and it persists across reload", async ({
    page,
  }) => {
    const VIEWPORT_WIDTH = 1512;
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: 944 });
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "rail-flush-collapse.md",
      "",
      "# rail-flush-collapse\n\nBody text for the 260721-cjt flush-collapse UAT.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, noteId);

    // (1) Expanded (default): no tab-bar toggle; the rail's own header owns
    // the sole collapse control (unchanged from 30-13).
    await expect(page.getByTestId("tab-strip-right-cluster")).toHaveCount(0);
    const tabRow = page.getByTestId("right-rail-tab-row");
    await expect(tabRow).toBeVisible({ timeout: 5_000 });
    const collapseBtn = tabRow.getByRole("button", { name: "Collapse panels" });
    await expect(collapseBtn).toBeVisible();

    // (2) Collapse via the rail's own control — the rail unmounts ENTIRELY
    // (no collapsed strip of any kind), and the editor becomes flush with
    // the right window edge.
    await collapseBtn.click();
    await expect(tabRow).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId("right-rail-collapsed")).toHaveCount(0);
    await expect(page.locator("aside")).toHaveCount(0);

    const paneTree = page.getByTestId("pane-tree");
    await expect
      .poll(
        async () => {
          const box = await paneTree.boundingBox();
          return box === null ? null : Math.round(box.x + box.width);
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(VIEWPORT_WIDTH - 2);

    // (3) The rightmost pane's tab bar now shows exactly one reopen toggle
    // — the sole rail-state affordance on the whole page.
    const rightCluster = page.getByTestId("tab-strip-right-cluster");
    await expect(rightCluster).toHaveCount(1);
    const reopenBtn = rightCluster.getByRole("button", { name: "Show panels" });
    await expect(reopenBtn).toBeVisible();
    await expect(page.getByRole("button", { name: /show panels/i })).toHaveCount(1);

    // (4) Click the tab-bar toggle — the rail reopens, the tab-bar cluster
    // unmounts.
    await reopenBtn.click();
    await expect(tabRow).toBeVisible({ timeout: 5_000 });
    await expect(rightCluster).toHaveCount(0);

    // (5) Re-collapse, reload — collapsed state (and the flush/toggle
    // contract) survives the reload.
    await collapseBtn.click();
    await expect(tabRow).toHaveCount(0, { timeout: 5_000 });
    await expect(rightCluster).toHaveCount(1);

    await page.reload();
    await waitForConnected(page);
    await expect(page.getByTestId("right-rail-tab-row")).toHaveCount(0);
    await expect(page.getByTestId("tab-strip-right-cluster")).toHaveCount(1, {
      timeout: 8_000,
    });

    // Leave the rail expanded for any subsequent test in this file.
    await page
      .getByTestId("tab-strip-right-cluster")
      .getByRole("button", { name: "Show panels" })
      .click();
    await expect(page.getByTestId("right-rail-tab-row")).toBeVisible({
      timeout: 5_000,
    });
  });
});
