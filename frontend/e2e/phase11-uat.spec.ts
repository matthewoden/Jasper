/**
 * Settings UI Panel.
 *
 * All synchronization uses deterministic assertion-based waits
 * (expect(...).toBeVisible(), expect(...).toBeChecked(), waitForFunction).
 *
 * SET-E2E-1: Open settings panel → toggle reading font Serif → --font-reading CSS var updated
 * SET-E2E-2: Open settings panel → change font size to 18 → blur → CSS var updated
 * SET-E2E-3: Unmanaged config key survives settings round-trip
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

test.describe("Settings panel (@phase11)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  /**
   * SET-E2E-1: Open the gear → settings panel visible → toggle reading font to Serif →
   * assert --font-reading CSS var on <html> updates to include "Source Serif 4".
   * Previous theme toggle removed — dark-only.
   */
  test("SET-E2E-1: open settings panel → toggle reading font Serif → --font-reading CSS var updates @phase11", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);

    await page.getByTestId("settings-menu-trigger").click();

    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // Toggle reading font to Serif via the reading-font group.
    const readingFontGroup = page.getByRole("group", { name: "Reading font" });
    await readingFontGroup.getByRole("button", { name: "Serif" }).click();

    // --font-reading on <html> must now contain "Source Serif 4" (applyReadingFont sets property).
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--font-reading").trim(),
          ),
        {
          message:
            "Expected --font-reading to contain 'Source Serif 4' after clicking Serif",
          timeout: 5_000,
        },
      )
      .toContain("Source Serif 4");

    await page.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();
  });

  /**
   * SET-E2E-2: Open gear → fill font-size input with 18 → blur → assert
   * --editor-font-size CSS var updated on <html>.
   */
  test("SET-E2E-2: change font size → editor font CSS var updates live @phase11", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);

    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // replaced the old single-field "Editor font size" label with
    // the Appearance pane's SliderNumberPair (aria-label "Font size", role
    // spinbutton for the number half) — settings always opens on
    // Appearance, so no extra nav click is needed.
    const fontInput = page.getByRole("spinbutton", { name: "Font size" });
    await fontInput.clear();
    await fontInput.fill("18");

    await fontInput.blur();

    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--editor-font-size"),
          ),
        { message: "Expected --editor-font-size to be 18px after font input blur" },
      )
      .toBe("18px");

    await page.getByRole("button", { name: "Close" }).click();
  });

  /**
   * SET-E2E-3: Inject an unmanaged key into config.json before navigating,
   * then change a setting via the panel and assert the unmanaged key survives
   * the round-trip (SaveMerged must not clobber unknown fields).
   *
   * removed config.Config.DisplayName entirely (a vault's
   * name is its folder name, not a stored field), so the "Display name"
   * field this test originally drove no longer exists. The Editor pane's
   * autosave-interval field is the smallest still-existing control that
   * triggers the same PUT /config round-trip this test is actually about.
   *
   * Polling reads config.json until autosaveMs is updated, bounded at 5s.
   */
  test("SET-E2E-3: unmanaged config field survives settings round-trip @phase11", async ({
    page,
  }) => {
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

    await page.goto(jasper.baseURL);

    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Editor", exact: true }).click();
    const autosaveInput = page.getByRole("spinbutton", { name: "Autosave interval" });
    await autosaveInput.clear();
    await autosaveInput.fill("3500");

    await autosaveInput.blur();

    await page.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();

    // Poll until config.json reflects the new autosaveMs — PUT is async from
    // the server's perspective. Bounded at 5s to catch genuine failures.
    await expect.poll(
      async () => {
        try {
          const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as {
            editor?: { autosaveMs?: number };
          };
          return saved.editor?.autosaveMs ?? 0;
        } catch {
          return 0;
        }
      },
      {
        timeout: 5000,
        message: "config.json should contain updated editor.autosaveMs 3500",
      },
    ).toBe(3500);

    const saved = JSON.parse(
      await fs.readFile(configPath, "utf8"),
    ) as Record<string, unknown>;
    expect(saved["_jasper_test_unmanaged_key"]).toBe("preserved");
  });
});
