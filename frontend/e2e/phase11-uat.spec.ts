/**
 * Phase 11 UAT — Settings UI Panel.
 *
 * All synchronization uses deterministic assertion-based waits
 * (expect(...).toBeVisible(), expect(...).toBeChecked(), waitForFunction).
 *
 * SET-E2E-1: Open settings panel → change theme → reopen → persisted Light selected
 * SET-E2E-2: Open settings panel → change font size to 18 → blur → CSS var updated
 * SET-E2E-3: Unmanaged config key survives settings round-trip
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

test.describe("Phase 11 Settings panel (@phase11)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
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

    await page.getByTestId("settings-menu-trigger").click();

    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    await page.getByLabel("Light").click();

    await page.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();

    await page.getByTestId("settings-menu-trigger").click();
    await expect(dialog).toBeVisible();

    const lightRadio = page.getByLabel("Light");
    await expect(lightRadio).toBeChecked();

    await page.getByRole("button", { name: "Close" }).click();
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

    const fontInput = page.getByLabel("Editor font size");
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
   * Polling reads config.json until display_name is updated, bounded at 5s.
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

    const displayInput = page.getByLabel("Display name");
    await displayInput.clear();
    await displayInput.fill("Test Vault E2E");

    await displayInput.blur();

    await page.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();

    // Poll until config.json reflects the new display_name — PUT is async from
    // the server's perspective. Bounded at 5s to catch genuine failures.
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

    const saved = JSON.parse(
      await fs.readFile(configPath, "utf8"),
    ) as Record<string, unknown>;
    expect(saved["_jasper_test_unmanaged_key"]).toBe("preserved");
  });
});
