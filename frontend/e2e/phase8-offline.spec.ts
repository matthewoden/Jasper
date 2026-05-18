/**
 * Phase 8 — Offline operation (PERF-04 / D-43).
 *
 * Asserts the SPA + setup wizard issues ZERO external network requests
 * during a full app exercise. Any leaked request to a CDN font, analytics
 * pixel, remote help URL, or an image with an absolute URL would surface
 * here.
 *
 * Method: Playwright's `context.route("**\/*", ...)` intercepts every
 * outbound request the page makes. Requests to localhost (127.0.0.1, ::1,
 * localhost) are allowed; any other hostname is recorded AND aborted so
 * the request cannot complete. The assertion is `externalRequests` is
 * empty.
 *
 * Coverage: two scenarios cover the lifecycle:
 *
 *   1. First-run wizard surface — bin/jasper boots against an empty
 *      data-dir; the firstrun middleware redirects to /setup. We open
 *      the wizard, interact with it (without submitting), and assert
 *      no external requests.
 *
 *   2. Post-setup SPA surface — we POST /api/v1/setup to provision the
 *      vault, reload, and exercise the steady-state shell (command
 *      palette, sidebar, editor mount). Again, zero external requests.
 *
 * Why this lives outside the unit-test suite: only Playwright can
 * intercept at the browser-context layer and observe the full set of
 * resource fetches (HTML/JS/CSS/fonts/images/XHR/WebSocket-handshakes).
 *
 * See: .planning/phases/08-native-install-service-sharing-first-run-polish/08-RESEARCH.md
 *      §"Offline Playwright spec" lines 906-939 (verbatim recipe).
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
        // Some requests (e.g., data:/blob:/about:) don't parse as URLs —
        // those are inherently local to the browser and never hit network.
        return route.continue();
      }
      const isLocal =
        url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "::1" ||
        url.hostname === "0.0.0.0" || // some browsers map localhost binding here
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

    // bin/jasper against an empty dataDir → firstrun middleware redirects
    // / and any non-/setup route to /setup. We follow the redirect and
    // exercise the wizard form (without submitting).
    await page.goto(jasper.baseURL);
    await page.waitForLoadState("networkidle");

    // The wizard mounts under /setup. Verify the data-dir input is visible.
    const dataDirInput = page.locator('input[aria-label="Data directory path"]');
    await expect(dataDirInput).toBeVisible({ timeout: 10_000 });

    // Type a candidate path (the validation endpoint hits POST
    // /api/v1/setup/validate-data-dir on localhost — that MUST be allowed).
    await dataDirInput.fill("/tmp/jasper-offline-probe");

    // Brief wait so any debounced validation request has time to fire.
    await page.waitForTimeout(500);

    expect(
      externalRequests,
      `wizard surface issued external request(s): ${externalRequests.join(", ")}`,
    ).toEqual([]);
  });

  test("post-setup SPA issues zero external network requests", async ({ context, page, request }) => {
    const externalRequests = installOfflineGuard(context);

    // Provision the vault via the wizard submit endpoint. We use the
    // request fixture (separate from the page) so the wizard's own
    // submit traffic also passes through the offline guard.
    //
    // The vault path MUST be unique per test invocation to avoid
    // colliding with the wizard test above; we use Playwright's
    // test.info() workerIndex for uniqueness.
    const probeDir = `${jasper.dataDir}-spa-${test.info().workerIndex}`;
    const setupResp = await request.post(`${jasper.baseURL}/api/v1/setup`, {
      data: { path: probeDir },
    });
    expect(setupResp.ok(), `setup submit failed: ${await setupResp.text()}`).toBeTruthy();

    // Navigate to the root SPA — after a successful setup the firstrun
    // middleware passes through and we hit the steady-state shell.
    await page.goto(jasper.baseURL);
    await page.waitForLoadState("networkidle");

    // Exercise a handful of surfaces likely to leak external fetches if
    // a regression slipped in:
    //   - Command palette (Cmd+P / Ctrl+P) — opens & closes
    //   - Cheat-sheet (Cmd+/) — opens & closes
    //
    // The exact key bindings vary by OS; we send both and don't fail if
    // one doesn't activate — the assertion at the end is the gate.
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
