/**
 * Phase 8 vault picker — fake-WSL E2E (Docker harness).
 *
 * Connects Playwright to the compose/wsl-validation jasper container,
 * which boots with JASPER_OSRELEASE_PATH pointed at a fake file containing
 * "microsoft" so platform.IsWSL() returns true. Asserts the Windows-form
 * breadcrumb labels and the dual-line footer render against a real running
 * binary — closes the gap between unit-test/mocked coverage and what a
 * user on a real WSL2 box would see.
 *
 * Run via:
 *   make test-wsl-e2e        (docker compose up + this spec + down)
 *
 * Or manually, after the container is up:
 *   JASPER_WSL_E2E=1 JASPER_WSL_HOST_PORT=6684 \
 *     npx playwright test phase8-wsl-vault.spec.ts
 *
 * Skipped by default — Playwright's standard `phase8-vault.spec.ts` runs
 * on every developer's macOS box; this spec only runs when the harness is
 * explicitly available (env-var gate). CI runs both.
 */

import { test, expect } from "@playwright/test";

const HOST_PORT = process.env.JASPER_WSL_HOST_PORT ?? "6684";
const BASE_URL = `http://127.0.0.1:${HOST_PORT}`;

test.describe("Phase 8 vault picker — Docker fake-WSL parity", () => {
  test.skip(
    process.env.JASPER_WSL_E2E !== "1",
    "Set JASPER_WSL_E2E=1 (or run `make test-wsl-e2e`) — requires compose/wsl-validation up",
  );

  test("Browse… renders Windows-form breadcrumb against a real WSL-shaped backend", async ({
    page,
  }) => {
    await page.goto(BASE_URL + "/");

    await expect(page.getByRole("dialog", { name: /vault/i })).toBeVisible();
    await page
      .getByTestId("vault-create-path-input")
      .fill("/mnt/c/Users/jasper-test");
    await page.getByTestId("vault-create-browse").click();
    await expect(page.getByTestId("folder-picker")).toBeVisible();

    const primary = page.getByTestId("folder-picker-current-path-primary");
    const secondary = page.getByTestId("folder-picker-current-path-secondary");
    await expect(primary).toHaveText(/^C:\\Users\\jasper-test$/);
    await expect(secondary).toHaveText("/mnt/c/Users/jasper-test");

    const crumb = page.getByTestId("folder-picker-breadcrumb");
    await expect(crumb.getByRole("button", { name: "C:\\" })).toBeVisible();
    await expect(crumb.getByRole("button", { name: "Users" })).toBeVisible();
    await expect(crumb.getByRole("button", { name: "jasper-test" })).toBeVisible();
    await expect(crumb.getByRole("button", { name: "mnt" })).toHaveCount(0);

    await page.getByTestId("folder-picker-entry-Documents").click();
    await expect(primary).toHaveText(/^C:\\Users\\jasper-test\\Documents$/);
    await expect(secondary).toHaveText("/mnt/c/Users/jasper-test/Documents");
    await expect(
      page.getByTestId("folder-picker-entry-Notes"),
    ).toBeVisible();
  });

  test("Breadcrumb segment click navigates via the WSL click-target (not the displayed label)", async ({
    page,
  }) => {
    await page.goto(BASE_URL + "/");
    await page
      .getByTestId("vault-create-path-input")
      .fill("/mnt/c/Users/jasper-test/Documents");
    await page.getByTestId("vault-create-browse").click();

    await expect(page.getByTestId("folder-picker")).toBeVisible();
    await expect(
      page.getByTestId("folder-picker-current-path-primary"),
    ).toHaveText(/Documents/);

    await page
      .getByTestId("folder-picker-breadcrumb")
      .getByRole("button", { name: "Users" })
      .click();
    await expect(
      page.getByTestId("folder-picker-current-path-primary"),
    ).toHaveText(/^C:\\Users$/);
    await expect(
      page.getByTestId("folder-picker-current-path-secondary"),
    ).toHaveText("/mnt/c/Users");
    await expect(
      page.getByTestId("folder-picker-entry-jasper-test"),
    ).toBeVisible();
  });

  test("Non-/mnt path (e.g. /tmp) falls back to POSIX breadcrumb even on WSL", async ({
    page,
  }) => {
    await page.goto(BASE_URL + "/");
    await page
      .getByTestId("vault-create-path-input")
      .fill("/mnt/c/Users/jasper-test");
    await page.getByTestId("vault-create-browse").click();
    await page.getByTestId("folder-picker-breadcrumb").dblclick();
    const input = page.getByTestId("folder-picker-path-input");
    await input.fill("/tmp");
    await input.press("Enter");

    const crumb = page.getByTestId("folder-picker-breadcrumb");
    await expect(crumb.getByRole("button", { name: "/" })).toBeVisible();
    await expect(crumb.getByRole("button", { name: "tmp" })).toBeVisible();
    await expect(
      page.getByTestId("folder-picker-current-path-secondary"),
    ).toHaveCount(0);
  });
});
