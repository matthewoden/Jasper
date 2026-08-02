/**
 * Tooltip UAT: proves the shared Radix Tooltip
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

test.describe("@phase31 shared Tooltip system (ribbon)", () => {
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

    // Native title= is removed by the Tooltip migration — the tooltip is the
    // only affordance now.
    await expect(quickSwitcher).not.toHaveAttribute("title", /.+/);

    await quickSwitcher.hover();

    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible({ timeout: 2_000 });
    await expect(tooltip).toContainText("Quick switcher");
    // Derive the expected shortcut glyph the same way the app does
    // (navigator.userAgent-based isMac in shortcutsRegistry.ts), rather than
    // process.platform — the Node test-runner's OS and the browser's
    // reported platform are not guaranteed to agree (e.g. sandboxed/headless
    // Chromium may report a non-Mac UA on a Mac host). Label and shortcut
    // are separate <span>s with no text-node space between them, so match
    // the shortcut without assuming a leading space.
    const isMac = await page.evaluate(() => navigator.userAgent.includes("Mac"));
    const shortcutText = isMac ? "⌘O" : "Ctrl O";
    await expect(tooltip).toContainText(shortcutText);
  });

  test("adjacent ribbon controls re-show their tooltip instantly (skipDelayDuration)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const isMac = await page.evaluate(() => navigator.userAgent.includes("Mac"));
    const mod = isMac ? "⌘" : "Ctrl ";
    const shift = isMac ? "⇧" : "Shift ";

    const today = page.getByRole("button", {
      name: "Open today's daily note",
    });
    const quickSwitcher = page.getByRole("button", { name: "Quick switcher" });
    await expect(today).toBeVisible({ timeout: 10_000 });
    await expect(quickSwitcher).toBeVisible();

    // First hover: pays the full show-delay (Radix delayDuration, ~400ms
    // per Tooltip.tsx) before the tooltip appears. Start on "Today" (the
    // middle ribbon button) — the ribbon's tooltips open to the RIGHT
    // (UAT gap-closure group A: below would collide with the next ribbon
    // icon in the 48px-wide rail), so it pops beside itself, clear of
    // "Quick switcher" above and "Command palette" below.
    await today.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible({ timeout: 2_000 });
    await expect(tooltip).toContainText("Today");
    await expect(tooltip).toContainText(`${mod}${shift}D`);

    // Move UP to the adjacent control (Quick switcher) without leaving the
    // ribbon's tooltip "group" — Radix's skipDelayDuration means this
    // second tooltip must reveal near-instantly instead of paying another
    // full delayDuration wait. The still-open "Today" tooltip renders to
    // the right of the ribbon (pointerEvents: none besides), so it can't
    // intercept the hover regardless of direction. A tight timeout well
    // below the show-delay proves the fast path fired (auto-retrying
    // assertion, no fixed sleep).
    const qsBox = await quickSwitcher.boundingBox();
    if (!qsBox) throw new Error("Quick switcher button has no bounding box");
    await page.mouse.move(qsBox.x + qsBox.width / 2, qsBox.y + qsBox.height / 2, {
      steps: 10,
    });
    // 300ms is comfortably below the 400ms full delayDuration (Tooltip.tsx)
    // while leaving enough margin over 150ms for the re-render to land —
    // still proves the skipDelayDuration fast path, not a flake-prone edge.
    await expect(tooltip).toContainText("Quick switcher", { timeout: 300 });
    await expect(tooltip).toContainText(`${mod}O`);
  });
});
