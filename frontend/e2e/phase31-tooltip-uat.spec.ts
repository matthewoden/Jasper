/**
 * Phase 31 D-07/D-08/D-09 tooltip UAT: proves the shared Radix Tooltip
 * system against a real embedded binary + real hover (never synthetic
 * events, memory verify-dnd-with-real-mouse's broader lesson).
 *
 * Covers:
 *   (a) hovering an icon-only ribbon control reveals its Tooltip content
 *       (label + shortcut) after the configured show delay.
 *   (b) once a tooltip has shown, hovering an ADJACENT ribbon control
 *       re-shows instantly via Radix's skipDelayDuration — no repeat of
 *       the full show-delay wait.
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) before Playwright — this spec runs against the EMBEDDED binary.
 *
 * Discipline: zero fixed sleeps; every timing-sensitive assertion uses
 * Playwright's own auto-retrying `expect(...).toBeVisible()` polling
 * (memory no-flaky-tests) — never `page.waitForTimeout`.
 */
import { test, expect } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected } from "./helpers/phase7Helpers";

test.describe("@phase31 D-07/D-08/D-09: shared Tooltip system (ribbon)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("hovering a ribbon icon reveals its Tooltip label + shortcut", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const quickSwitcher = page.getByRole("button", { name: "Quick switcher" });
    await expect(quickSwitcher).toBeVisible({ timeout: 10_000 });

    // Native title= is removed by the D-07 migration — the tooltip is the
    // only affordance now.
    await expect(quickSwitcher).not.toHaveAttribute("title", /.+/);

    await quickSwitcher.hover();

    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible({ timeout: 2_000 });
    await expect(tooltip).toContainText("Quick switcher");
    // Shortcut glyph: ⌘O on Mac, "Ctrl O" elsewhere (mod/shift constants,
    // shortcutsRegistry.ts) — assert whichever this platform renders.
    const shortcutText = process.platform === "darwin" ? "⌘O" : "Ctrl O";
    await expect(tooltip).toContainText(shortcutText);
  });

  test("adjacent ribbon controls re-show their tooltip instantly (skipDelayDuration)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const quickSwitcher = page.getByRole("button", { name: "Quick switcher" });
    const today = page.getByRole("button", {
      name: "Open today's daily note",
    });
    await expect(quickSwitcher).toBeVisible({ timeout: 10_000 });
    await expect(today).toBeVisible();

    // First hover: pays the full show-delay (Radix delayDuration, ~400ms
    // per Tooltip.tsx) before the tooltip appears.
    await quickSwitcher.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible({ timeout: 2_000 });
    await expect(tooltip).toContainText("Quick switcher");

    // Move directly to the adjacent control (Today) without leaving the
    // ribbon's tooltip "group" — Radix's skipDelayDuration means this
    // second tooltip must reveal near-instantly instead of paying another
    // full delayDuration wait. A tight timeout well below the show-delay
    // proves the fast path fired (auto-retrying assertion, no fixed sleep).
    await today.hover();
    await expect(tooltip).toContainText("Today", { timeout: 150 });
    const shortcutText = process.platform === "darwin" ? "⌘⇧D" : "Ctrl Shift D";
    await expect(tooltip).toContainText(shortcutText);
  });
});
