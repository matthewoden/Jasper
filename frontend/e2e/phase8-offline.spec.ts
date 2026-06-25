/**
 * Phase 8 — Offline operation.
 *
 * Asserts the SPA + setup wizard issue ZERO external network requests during
 * a full app exercise. Any leaked request to a CDN font, analytics pixel,
 * remote help URL, or image with an absolute URL would surface here.
 *
 * Method: Playwright's `context.route("**\/*", ...)` intercepts every
 * outbound request. Localhost requests (127.0.0.1 / ::1 / localhost) are
 * allowed; anything else is recorded AND aborted. The assertion is that
 * `externalRequests` is empty.
 *
 * Two scenarios cover the lifecycle:
 *   1. First-run wizard — no external requests.
 *   2. Post-setup SPA shell (command palette, sidebar, editor mount) — no
 *      external requests.
 *
 * Lives outside the unit-test suite because only Playwright can intercept at
 * the browser-context layer and observe resource fetches
 * (HTML/JS/CSS/fonts/images/XHR/WebSocket-handshakes).
 */
import { test, expect } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

test.describe("Phase 8 — offline operation (PERF-04 / D-43)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  /**
   * Helper: install a route handler on the given Playwright context that
   * tracks every outbound request. Local-host requests (127.0.0.1 / ::1
   * / localhost) are allowed via `route.continue()`; anything else is
   * recorded AND aborted via `route.abort()`. Returns a mutable array
   * the caller can assert against after exercising the page.
   *
   * Why we abort (rather than continue): if a regression slips in an
   * external CDN fetch, we WANT the page to fail visibly in the test —
   * an aborted request is more diagnostic than a request that quietly
   * succeeds and pollutes a coworker's network metrics.
   */
  function installOfflineGuard(context: import("@playwright/test").BrowserContext): string[] {
    const externalRequests: string[] = [];
    void context.route("**/*", (route, request) => {
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        return route.continue();
      }
      const isLocal =
        url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "::1" ||
        url.hostname === "0.0.0.0" ||
        url.protocol === "data:" ||
        url.protocol === "blob:" ||
        url.protocol === "about:";
      if (!isLocal) {
        externalRequests.push(request.url());
        return route.abort();
      }
      return route.continue();
    });
    return externalRequests;
  }

  test("first-run wizard issues zero external network requests", async ({ context, page }) => {
    const externalRequests = installOfflineGuard(context);

    await page.goto(jasper.baseURL);
    await page.waitForLoadState("networkidle");

    // config.Load auto-writes defaults before the listener accepts connections,
    // so first_run=false and the SPA renders the vault picker (not the setup wizard).
    // The vault picker's Create-new tab is the default when no recents exist.
    const dataDirInput = page.getByTestId("vault-create-path-input");
    await expect(dataDirInput).toBeVisible({ timeout: 10_000 });

    await dataDirInput.fill("/tmp/jasper-offline-probe");

    await page.waitForTimeout(500);

    expect(
      externalRequests,
      `wizard surface issued external request(s): ${externalRequests.join(", ")}`,
    ).toEqual([]);
  });

  test("post-setup SPA issues zero external network requests", async ({ context, page, request }) => {
    const externalRequests = installOfflineGuard(context);

    const probeDir = `${jasper.dataDir}-spa-${test.info().workerIndex}`;
    const createResp = await request.post(`${jasper.baseURL}/api/v1/vault/create`, {
      data: { path: probeDir, theme: "dark", daily_template: "", mcp_enabled: false },
    });
    expect(createResp.ok(), `vault/create failed: ${await createResp.text()}`).toBeTruthy();
    await request.post(`${jasper.baseURL}/api/v1/vault/open`, {
      data: { path: probeDir },
    });

    await page.goto(jasper.baseURL);
    await page.waitForLoadState("networkidle");

    await page.keyboard.press("Control+P");
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+P");
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Slash");
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");

    expect(
      externalRequests,
      `steady-state SPA issued external request(s): ${externalRequests.join(", ")}`,
    ).toEqual([]);
  });
});
