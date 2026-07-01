/**
 * Phase 17.1 UAT — Settings Dialog UX Post-Redesign Fixes.
 *
 * SET2-01: Settings dialog height ≤ viewport − 48px; header+footer stay sticky
 *   after scrolling body to the bottom. Currently RED: footer is inside the
 *   scroll area and scrolls out of view (no sticky layout yet).
 *
 * SET2-05: Changing display_name in Settings and reloading shows the new name
 *   in the StatusBar and in the Settings input. Currently RED: PutConfig does
 *   not sync app.json, so GET /vault/current keeps returning the old name.
 *
 * SET2-06: Clicking a breadcrumb segment (data-testid="breadcrumb-segment")
 *   reveals the note in the sidebar and applies .jasper-pulse-target. Currently
 *   RED: the breadcrumb is a plain text element with no interactive segments.
 *
 * RED scaffold — DO NOT weaken assertions to make them pass. Fix production code.
 *
 * Pattern: one binary per describe (mirrors phase17-uat.spec.ts). All waits are
 * deterministic polls; no page.waitForTimeout() / fixed sleeps.
 */
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
    "SET2-01: dialog height ≤ viewport − 48px and header+Done button remain visible after body scroll @SET2-01",
    async ({ page }) => {
      await waitConnected(page, jasper.baseURL);

      // Open Settings
      await page.getByTestId("settings-menu-trigger").click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Assert dialog bounding box height ≤ viewport height − 48px
      const viewportHeight = page.viewportSize()?.height ?? 800;
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox).not.toBeNull();
      // RED: dialog currently has max-height: 85vh without accounting for a
      // 48px toolbar clearance; assert the more precise ≤ viewport − 48px contract.
      expect(dialogBox!.height).toBeLessThanOrEqual(viewportHeight - 48);

      // Scroll the dialog body to the very bottom (simulates full content load)
      await page.evaluate(() => {
        const content = document.querySelector('[role="dialog"]');
        if (content) {
          // Find the inner scrollable div (currently the entire Dialog.Content)
          const scrollable = Array.from(content.querySelectorAll("*")).find(
            (el) => (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight,
          ) as HTMLElement | undefined;
          if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
        }
      });

      // After scroll: header "Settings" title must still be in viewport
      // RED: currently the header is inside the scroll area and scrolls away.
      const heading = page.getByRole("heading", { name: "Settings" });
      await expect(heading).toBeInViewport({ timeout: 3_000 });

      // After scroll: footer "Done" button must still be in viewport
      // RED: currently the button is labelled "Close" and not sticky.
      // Plan 02 renames it "Done" and pins it to a sticky footer.
      const doneBtn = page.getByRole("button", { name: "Done" });
      await expect(doneBtn).toBeInViewport({ timeout: 3_000 });
    },
  );
});

// ---------------------------------------------------------------------------
// SET2-05: display_name persists across page reload
// ---------------------------------------------------------------------------

test.describe("SET2-05: display_name persists across reload (@phase17.1)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test(
    "SET2-05: display_name set in Settings appears in StatusBar and survives page reload @SET2-05",
    async ({ page }) => {
      await waitConnected(page, jasper.baseURL);

      // Unique name to rule out stale-state false positives
      const newName = `TestVault-${Date.now()}`;

      // Open Settings → set Display name
      await page.getByTestId("settings-menu-trigger").click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      const displayNameInput = page.getByLabel("Display name");
      await displayNameInput.clear();
      await displayNameInput.fill(newName);
      await displayNameInput.blur();

      // Wait for the save to settle (PUT fires on blur; poll for it)
      await expect
        .poll(
          async () => {
            const resp = await fetch(`${jasper.baseURL}/api/v1/vault/current`);
            if (!resp.ok) return "";
            const data = (await resp.json()) as { vault?: { display_name?: string } };
            return data.vault?.display_name ?? "";
          },
          { message: "Expected GET /vault/current to return new display_name after PUT", timeout: 8_000 },
        )
        .toBe(newName);

      // Close the dialog (click the footer Done button specifically)
      await page.getByRole("button", { name: "Done" }).click();

      // StatusBar must reflect the new name immediately
      await expect(page.getByTestId("status-bar-vault")).toHaveText(newName, {
        timeout: 5_000,
      });

      // Reload the page
      await page.reload();
      await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 10_000 },
      );

      // RED: after reload, StatusBar still shows old name (app.json not synced)
      await expect(page.getByTestId("status-bar-vault")).toHaveText(newName, {
        timeout: 5_000,
      });

      // RED: re-opening Settings also shows old name in the input
      await page.getByTestId("settings-menu-trigger").click();
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({ timeout: 5_000 });
      await expect(page.getByLabel("Display name")).toHaveValue(newName);
    },
  );
});

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
