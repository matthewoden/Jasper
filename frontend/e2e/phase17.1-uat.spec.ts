import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function waitConnected(page: Page, baseURL: string): Promise<void> {
  await page.goto(baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

// ---------------------------------------------------------------------------
// SET2-01: Settings dialog sticky layout
// ---------------------------------------------------------------------------

test.describe("SET2-01: sticky Settings dialog (@phase17.1)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test(
    "SET2-01: dialog height ≤ viewport − 48px and header+Close button remain visible after body scroll @SET2-01",
    async ({ page }) => {
      // replaced the single scrollable-body dialog with a locked
      // 920x628 frame whose PaneHeader (56px, flexShrink: 0) and
      // NavColumn are structurally OUTSIDE the per-pane scroll region — only
      // the content div below PaneHeader scrolls. A small viewport forces
      // the maxHeight: 82vh cap well below the natural 628px height,
      // guaranteeing the active pane's content overflows so this test
      // exercises a real scroll, not a no-op.
      await page.setViewportSize({ width: 1200, height: 500 });
      await waitConnected(page, jasper.baseURL);

      // Open Settings
      await page.getByTestId("settings-menu-trigger").click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Assert dialog bounding box height ≤ viewport height − 48px
      const viewportHeight = page.viewportSize()?.height ?? 800;
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox).not.toBeNull();
      expect(dialogBox!.height).toBeLessThanOrEqual(viewportHeight - 48);

      // PaneHeader's subtitle for the default Appearance pane — the
      // element to prove stays put while the pane's OWN content scrolls.
      const paneSubtitle = dialog.getByText("Accent and typography", { exact: true });
      const closeBtn = dialog.getByRole("button", { name: "Close settings" });
      await expect(paneSubtitle).toBeInViewport({ timeout: 3_000 });
      await expect(closeBtn).toBeInViewport({ timeout: 3_000 });
      const subtitleBoxBefore = await paneSubtitle.boundingBox();
      const closeBoxBefore = await closeBtn.boundingBox();

      // Scroll the pane's OWN content region (not the whole dialog, not the
      // nav column) to the very bottom.
      await page.evaluate(() => {
        const dialogEl = document.querySelector('[role="dialog"]');
        if (!dialogEl) return;
        const scrollable = Array.from(dialogEl.querySelectorAll("*")).find(
          (el) => (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight,
        ) as HTMLElement | undefined;
        if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
      });

      // After scroll: PaneHeader subtitle and Close control must still be
      // visible AND at the exact same position — proving they live outside
      // the scrolled region entirely, not merely "still on screen".
      await expect(paneSubtitle).toBeInViewport({ timeout: 3_000 });
      await expect(closeBtn).toBeInViewport({ timeout: 3_000 });
      expect(await paneSubtitle.boundingBox()).toEqual(subtitleBoxBefore);
      expect(await closeBtn.boundingBox()).toEqual(closeBoxBefore);
    },
  );
});

// SET2-05 is retired, not skipped: config.Config.DisplayName was deleted
// outright, and a vault's display name is now always the derived
// filepath.Base of its data directory. There is no Settings control left for
// this test to target — the capability is gone, not just its UI.

// ---------------------------------------------------------------------------
// SET2-06: breadcrumb segment reveals note in Files sidebar
// ---------------------------------------------------------------------------

test.describe("SET2-06: breadcrumb segment reveal (@phase17.1)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();

    // Seed a nested note so there is a breadcrumb with folder segments
    await fetch(`${jasper.baseURL}/api/v1/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "BreadcrumbTestNote",
        path: "FolderA/SubB/BreadcrumbTestNote.md",
        content: "# BreadcrumbTestNote\n\nSeed note for SET2-06 breadcrumb reveal.\n",
      }),
    });
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test(
    "SET2-06: clicking breadcrumb-segment reveals the folder in the sidebar with pulse highlight @SET2-06",
    async ({ page }) => {
      await waitConnected(page, jasper.baseURL);

      // Open the nested note via the API-known path (click its tree row)
      const noteRow = page.locator('[data-tree-row-kind="note"]', { hasText: "BreadcrumbTestNote" });
      // The note may be nested; expand parent folders by polling for the row
      await expect
        .poll(
          async () => noteRow.isVisible(),
          { message: "Expected BreadcrumbTestNote tree row to appear", timeout: 10_000 },
        )
        .toBe(true);

      await noteRow.click();

      // Wait for the breadcrumb to appear (data-testid="note-breadcrumb")
      const breadcrumb = page.getByTestId("note-breadcrumb");
      await expect(breadcrumb).toBeVisible({ timeout: 5_000 });

      // Click the FIRST folder breadcrumb segment with a real pointer click.
      // RED: data-testid="breadcrumb-segment" does not exist yet (breadcrumb is
      // plain text rendered via breadcrumbTrail). This locator will time out.
      const firstSegment = page.getByTestId("breadcrumb-segment").first();
      await firstSegment.click({ timeout: 5_000 });

      // Assert sidebar is visible after the reveal
      await expect(page.getByTestId("sidebar-toolbar")).toBeVisible({ timeout: 3_000 });

      // Assert the pulse-highlight class appears on the target folder row
      // RED: .jasper-pulse-target does not exist (breadcrumb click not implemented)
      await expect
        .poll(
          async () => {
            const el = await page.$(".jasper-pulse-target");
            return el !== null;
          },
          { message: "Expected .jasper-pulse-target to appear on sidebar row after breadcrumb click", timeout: 5_000 },
        )
        .toBe(true);
    },
  );
});
