/**
 * Asserts the SPA and setup wizard issue ZERO external network requests.
 * context.route("**\/*") intercepts everything; loopback is allowed, anything
 * else is recorded and aborted.
 *
 * Lives outside the unit suite because only Playwright can intercept at the
 * browser-context layer and see fonts, images, XHR and WS handshakes.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const JASPER_BIN = path.join(repoRoot, "bin", "jasper");

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        reject(new Error("could not allocate free port"));
      }
    });
  });
}

/**
 * Spawn jasper with JASPER_APP_HOME but NO --vault override, so GET
 * /vault/current returns null and the SPA mounts the VaultPicker (first-run
 * surface). The shared spawnJasper() passes --vault, which bypasses the picker
 * — wrong for the first-run offline assertion. Mirrors phase8-vault's local
 * spawn helper.
 */
async function spawnNoVaultJasper(
  appHome: string,
): Promise<{ proc: ChildProcess; baseURL: string; kill: () => void }> {
  if (!fs.existsSync(JASPER_BIN)) {
    throw new Error(
      `bin/jasper missing — run \`make build\` first (CLAUDE.md §Build & embed pipeline). ` +
        `Expected at: ${JASPER_BIN}`,
    );
  }
  const port = await findFreePort();
  const proc = spawn(JASPER_BIN, ["serve", "--bind", `127.0.0.1:${port}`], {
    env: { ...process.env, JASPER_APP_HOME: appHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (b) => process.stderr.write(`[jasper] ${b}`));
  proc.stderr?.on("data", (b) => process.stderr.write(`[jasper] ${b}`));

  const baseURL = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      const r = await fetch(`${baseURL}/api/v1/vault/current`);
      if (r.ok || r.status === 404) break;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { proc, baseURL, kill: () => proc.kill("SIGTERM") };
}

test.describe("offline operation — no runtime CDN dependency", () => {
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
    // A no-vault binary is required so GET /vault/current returns null and the
    // SPA mounts the VaultPicker. The shared spawnJasper() passes --vault, which
    // sets the current vault and bypasses the picker entirely.
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-offline-app-"));
    const noVault = await spawnNoVaultJasper(appHome);
    try {
      const externalRequests = installOfflineGuard(context);

      await page.goto(noVault.baseURL);
      await page.waitForLoadState("networkidle");

      // No current vault → SPA renders the vault picker. Its Create-new tab is
      // the default when no recents exist.
      const dataDirInput = page.getByTestId("vault-create-path-input");
      await expect(dataDirInput).toBeVisible({ timeout: 10_000 });

      await dataDirInput.fill("/tmp/jasper-offline-probe");

      await page.waitForTimeout(500);

      expect(
        externalRequests,
        `wizard surface issued external request(s): ${externalRequests.join(", ")}`,
      ).toEqual([]);
    } finally {
      noVault.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
    }
  });

  test("post-setup SPA issues zero external network requests", async ({ context, page, request }) => {
    const externalRequests = installOfflineGuard(context);

    const probeDir = `${jasper.dataDir}-spa-${test.info().workerIndex}`;
    const createResp = await request.post(`${jasper.baseURL}/api/v1/vault/create`, {
      data: { path: probeDir, theme: "dark", daily_template: "" },
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
