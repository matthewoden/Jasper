/**
 * Phase 11 UAT — Settings UI Panel (Plan 03 Tasks 4 / SET-E2E-1..3).
 *
 * Per CONVENTIONS.md §"Verification policy: E2E before human UAT" and
 * §"Build & embed pipeline" (make build is mandatory — never npm run build
 * && go build which skips the embed copy step).
 *
 * Per CONVENTIONS.md §"Flaky tests are bugs": all synchronization uses
 * deterministic assertion-based waits (expect(...).toBeVisible(),
 * expect(...).toBeChecked(), waitForFunction). Where a short settle wait is
 * unavoidable (async PUT to complete after UI close), it is documented below.
 *
 * SET-E2E-1: Open settings panel → change theme → reopen → persisted Light selected
 * SET-E2E-2: Open settings panel → change font size to 18 → blur → CSS var updated
 * SET-E2E-3: Unmanaged config key survives settings round-trip (SET-05 coverage)
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

test.describe("Phase 11 Settings panel (@phase11)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    // spawnJasper with no dataDir creates an ephemeral tmpdir and boots with
    // --vault flag, skipping the first-run wizard redirect.
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  /**
   * SET-E2E-1: Open the gear → settings panel visible → click Light radio →
   * close → reopen → Light radio is checked (persistence round-trip via PUT /config
   * and GET /config on next open).
   */
  test("SET-E2E-1: open settings panel → change theme live → reopen shows saved @phase11", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);

    // Open settings via the gear button
    await page.getByTestId("settings-menu-trigger").click();

    // Dialog must be visible
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // Click Light radio
    await page.getByLabel("Light").click();

    // Close dialog
    await page.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();

    // Reopen — the Light radio must still be checked (persisted to config)
    await page.getByTestId("settings-menu-trigger").click();
    await expect(dialog).toBeVisible();

    const lightRadio = page.getByLabel("Light");
    await expect(lightRadio).toBeChecked();

    // Close
    await page.getByRole("button", { name: "Close" }).click();
  });

  /**
   * SET-E2E-2: Open gear → fill font-size input with 18 → blur → assert
   * document.documentElement.style.getPropertyValue("--editor-font-size") === "18px"
   * (live CSS-var apply from the panel side, per SET-04 panel half).
   */
  test("SET-E2E-2: change font size → editor font CSS var updates live @phase11", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);

    // Open settings
    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // Clear and fill the font size input
    const fontInput = page.getByLabel("Editor font size");
    await fontInput.clear();
    await fontInput.fill("18");

    // Blur to trigger commit
    await fontInput.blur();

    // Assert CSS var updated on <html>
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--editor-font-size"),
          ),
        { message: "Expected --editor-font-size to be 18px after font input blur" },
      )
      .toBe("18px");

    // Close
    await page.getByRole("button", { name: "Close" }).click();
  });

  /**
   * SET-E2E-3: Inject an unmanaged key into config.json on disk before
   * navigating, then open the settings panel → change display name → blur →
   * close → poll config.json until updated display_name appears → assert
   * unmanaged key still present (D-09 / SET-05 SaveMerged coverage against
   * the live binary).
   *
   * CR-04: replaced waitForTimeout(500) with expect.poll() to avoid a
   * fixed-sleep flaky pattern (CONVENTIONS §"Flaky tests are bugs").
   * Polling reads config.json until display_name is updated, bounded at 5s.
   */
  test("SET-E2E-3: unmanaged config field survives settings round-trip @phase11", async ({
    page,
  }) => {
    // Write the extra unmanaged key into the jasper data dir's config.json
    const configPath = path.join(jasper.dataDir, ".jasper", "config.json");

    // Read existing config (may not exist yet — server may not have written it)
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // File may not exist on first boot; it will be created by the server
    }
    raw["_jasper_test_unmanaged_key"] = "preserved";
    await fs.writeFile(configPath, JSON.stringify(raw, null, 2));

    // Navigate to app (server reads config fresh from disk on request)
    await page.goto(jasper.baseURL);

    // Open settings panel
    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // Trigger a PUT /config by changing the display name
    const displayInput = page.getByLabel("Display name");
    await displayInput.clear();
    await displayInput.fill("Test Vault E2E");

    // Blur to persist (await handler — saveConfig is now awaited in SettingsDialog)
    await displayInput.blur();

    // Close dialog
    await page.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();

    // CR-04: poll config.json until display_name matches — no fixed sleep.
    // The PUT is async from the server's perspective; poll until the persisted
    // value matches what we set. Bounded at 5s to catch genuine failures.
    await expect.poll(
      async () => {
        try {
          const saved = JSON.parse(
            await fs.readFile(configPath, "utf8"),
          ) as Record<string, unknown>;
          return (saved.display_name as string | undefined) ?? "";
        } catch {
          return "";
        }
      },
      {
        timeout: 5000,
        message: "config.json should contain updated display_name 'Test Vault E2E'",
      },
    ).toBe("Test Vault E2E");

    // Read config.json from disk and assert the unmanaged key survived
    const saved = JSON.parse(
      await fs.readFile(configPath, "utf8"),
    ) as Record<string, unknown>;
    expect(saved["_jasper_test_unmanaged_key"]).toBe("preserved");
  });
});
