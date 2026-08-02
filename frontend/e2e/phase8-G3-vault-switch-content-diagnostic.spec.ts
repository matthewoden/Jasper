/**
 * Diagnostic, not an assertion suite: captures WS frames, console messages, page
 * navigations, and the editor's textContent before and after a vault switch, to
 * separate "SPA never reloads" from "server-side race" as the cause.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

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

async function waitForVaultEndpoint(baseURL: string, deadlineMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await fetch(`${baseURL}/api/v1/vault/current`);
      if (r.ok || r.status === 404) return;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`jasper did not become ready at ${baseURL} within ${deadlineMs}ms`);
}

interface VaultHandle {
  proc: ChildProcess;
  baseURL: string;
  appHome: string;
  logBuffer: string[];
  kill: () => void;
}

async function spawnVaultJasper(appHome: string): Promise<VaultHandle> {
  if (!fs.existsSync(JASPER_BIN)) {
    throw new Error(`bin/jasper missing — run 'make build' first. Expected at: ${JASPER_BIN}`);
  }
  const port = await findFreePort();
  const proc = spawn(
    JASPER_BIN,
    ["serve", "--bind", `127.0.0.1:${port}`],
    {
      env: { ...process.env, JASPER_APP_HOME: appHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const logBuffer: string[] = [];
  proc.stdout?.on("data", (b) => {
    const line = b.toString();
    logBuffer.push(`[stdout] ${line}`);
    process.stderr.write(`[jasper] ${line}`);
  });
  proc.stderr?.on("data", (b) => {
    const line = b.toString();
    logBuffer.push(`[stderr] ${line}`);
    process.stderr.write(`[jasper] ${line}`);
  });

  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitForVaultEndpoint(baseURL, 15_000);
  } catch (e) {
    proc.kill("SIGTERM");
    throw e;
  }
  return {
    proc,
    baseURL,
    appHome,
    logBuffer,
    kill: () => proc.kill("SIGTERM"),
  };
}

async function bootstrapVault(baseURL: string, vaultDir: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/v1/vault/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: vaultDir,
      theme: "dark",
      daily_template: "",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`vault/create failed for ${vaultDir}: ${res.status} ${body}`);
  }
}

async function openVault(baseURL: string, vaultPath: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/v1/vault/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: vaultPath }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`vault/open failed: ${res.status} ${body}`);
  }
}

test.describe("G3 — vault switch content swap diagnostic", () => {
  test("switch from A to B: capture WS frames + console + nav + editor content", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "g3-app-"));
    const vaultA = fs.mkdtempSync(path.join(os.tmpdir(), "g3-A-"));
    const vaultB = fs.mkdtempSync(path.join(os.tmpdir(), "g3-B-"));
    let handle: VaultHandle | undefined;

    const wsFrames: Array<{ t: number; dir: "in" | "out"; event?: string; preview: string }> = [];
    const consoleEvents: Array<{ t: number; type: string; text: string }> = [];
    const navigations: Array<{ t: number; url: string; type: string }> = [];
    const requestEvents: Array<{ t: number; method: string; url: string }> = [];
    const responseEvents: Array<{ t: number; status: number; url: string; failure?: string }> = [];
    const t0 = Date.now();
    const ts = () => Date.now() - t0;

    try {
      handle = await spawnVaultJasper(appHome);

      await bootstrapVault(handle.baseURL, vaultA);
      await bootstrapVault(handle.baseURL, vaultB);

      const sentinelA = `# Vault A scratchpad\n\nUNIQUE_SENTINEL_AAAAA_${Date.now()}\n`;
      const sentinelB = `# Vault B scratchpad\n\nUNIQUE_SENTINEL_BBBBB_${Date.now()}\n`;
      fs.mkdirSync(path.join(vaultA, "notes"), { recursive: true });
      fs.mkdirSync(path.join(vaultB, "notes"), { recursive: true });
      fs.writeFileSync(path.join(vaultA, "notes", "scratchpad.md"), sentinelA);
      fs.writeFileSync(path.join(vaultB, "notes", "scratchpad.md"), sentinelB);

      await openVault(handle.baseURL, vaultA);

      page.on("console", (msg) => {
        consoleEvents.push({ t: ts(), type: msg.type(), text: msg.text() });
      });
      page.on("pageerror", (err) => {
        consoleEvents.push({ t: ts(), type: "pageerror", text: err.message });
      });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          navigations.push({ t: ts(), url: frame.url(), type: "framenavigated" });
        }
      });
      page.on("load", () => {
        navigations.push({ t: ts(), url: page.url(), type: "load" });
      });
      page.on("request", (req) => {
        if (req.url().includes("/api/v1/")) {
          requestEvents.push({ t: ts(), method: req.method(), url: req.url().replace(handle!.baseURL, "") });
        }
      });
      page.on("response", (res) => {
        if (res.url().includes("/api/v1/")) {
          responseEvents.push({ t: ts(), status: res.status(), url: res.url().replace(handle!.baseURL, "") });
        }
      });
      page.on("requestfailed", (req) => {
        if (req.url().includes("/api/v1/")) {
          responseEvents.push({
            t: ts(),
            status: 0,
            url: req.url().replace(handle!.baseURL, ""),
            failure: req.failure()?.errorText ?? "unknown",
          });
        }
      });
      page.on("websocket", (ws) => {
        wsFrames.push({ t: ts(), dir: "out", preview: `[connect] ${ws.url().replace(handle!.baseURL, "")}` });
        ws.on("framereceived", (data) => {
          let event: string | undefined;
          let preview = "";
          try {
            const obj = JSON.parse(data.payload.toString());
            event = obj.event;
            preview = JSON.stringify(obj).slice(0, 200);
          } catch {
            preview = String(data.payload).slice(0, 200);
          }
          wsFrames.push({ t: ts(), dir: "in", event, preview });
        });
        ws.on("framesent", (data) => {
          wsFrames.push({ t: ts(), dir: "out", preview: String(data.payload).slice(0, 100) });
        });
        ws.on("close", () => {
          wsFrames.push({ t: ts(), dir: "in", preview: "[ws closed]" });
        });
      });

      await page.goto(handle.baseURL + "/");
      await expect(page.getByTestId("status-bar-vault")).toBeVisible({ timeout: 10_000 });

      await page.getByText("scratchpad").first().click({ timeout: 5_000 });

      await page.waitForFunction(
        (sentinel) => document.body.textContent?.includes(sentinel) === true,
        "UNIQUE_SENTINEL_AAAAA_",
        { timeout: 10_000 },
      );

      const editorContentBefore = await page.evaluate(() => {
        const cm = document.querySelector(".cm-content");
        return cm?.textContent ?? "";
      });
      consoleEvents.push({ t: ts(), type: "info", text: `[diag] editor content BEFORE switch length=${editorContentBefore.length} contains_A=${editorContentBefore.includes("UNIQUE_SENTINEL_AAAAA_")} contains_B=${editorContentBefore.includes("UNIQUE_SENTINEL_BBBBB_")}` });

      await page.evaluate(() => {
        (window as unknown as { __g3PreReloadMark?: number }).__g3PreReloadMark = Date.now();
      });
      const preReloadMark = await page.evaluate(
        () => (window as unknown as { __g3PreReloadMark?: number }).__g3PreReloadMark,
      );
      consoleEvents.push({ t: ts(), type: "info", text: `[diag] set window.__g3PreReloadMark=${preReloadMark}` });

      consoleEvents.push({ t: ts(), type: "info", text: `[diag] clicking StatusBar to open switch picker` });
      await page.getByTestId("status-bar-vault").click();
      await expect(page.getByRole("dialog", { name: /vault/i })).toBeVisible({ timeout: 5_000 });

      await page.getByRole("tab", { name: /recent/i }).click();
      consoleEvents.push({ t: ts(), type: "info", text: `[diag] clicked Recent tab; about to click vault B row` });

      const switchClickTime = ts();
      await page.getByText(path.basename(vaultB)).first().click({ timeout: 5_000 });
      consoleEvents.push({ t: ts(), type: "info", text: `[diag] clicked vault-row-${vaultB} at t=${switchClickTime}` });

      await page.waitForTimeout(6000);

      const postWaitMark = await page.evaluate(
        () => (window as unknown as { __g3PreReloadMark?: number }).__g3PreReloadMark,
      );
      const reloadOccurred = postWaitMark === undefined;
      consoleEvents.push({ t: ts(), type: "info", text: `[diag] post-wait window.__g3PreReloadMark=${postWaitMark}; reloadOccurred=${reloadOccurred}` });

      const editorContentAfter = await page.evaluate(() => {
        const cm = document.querySelector(".cm-content");
        return cm?.textContent ?? "";
      });
      consoleEvents.push({ t: ts(), type: "info", text: `[diag] editor content AFTER switch length=${editorContentAfter.length} contains_A=${editorContentAfter.includes("UNIQUE_SENTINEL_AAAAA_")} contains_B=${editorContentAfter.includes("UNIQUE_SENTINEL_BBBBB_")}` });

      const vaultBScratchpad = path.join(vaultB, "notes", "scratchpad.md");
      const vaultBContent = fs.readFileSync(vaultBScratchpad, "utf8");
      consoleEvents.push({
        t: ts(),
        type: "info",
        text: `[diag] vault B scratchpad on disk: length=${vaultBContent.length} contains_A=${vaultBContent.includes("UNIQUE_SENTINEL_AAAAA_")} contains_B=${vaultBContent.includes("UNIQUE_SENTINEL_BBBBB_")}`,
      });
      expect(vaultBContent).toContain("UNIQUE_SENTINEL_BBBBB_");
      expect(vaultBContent).not.toContain("UNIQUE_SENTINEL_AAAAA_");

      const dumpPath = path.join(repoRoot, "test-results", "g3-diagnostic.json");
      fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
      fs.writeFileSync(
        dumpPath,
        JSON.stringify(
          {
            switchClickTime,
            reloadOccurred,
            editorContentBefore: editorContentBefore.slice(0, 300),
            editorContentAfter: editorContentAfter.slice(0, 300),
            wsFrames,
            consoleEvents,
            navigations,
            requestEvents,
            responseEvents,
            serverLog: handle.logBuffer.slice(-200),
          },
          null,
          2,
        ),
      );
      console.log(`\n[diag] wrote diagnostic dump to ${dumpPath}\n`);
      console.log(`\n[diag] SUMMARY:`);
      console.log(`  reloadOccurred=${reloadOccurred}`);
      console.log(`  editor BEFORE: ${editorContentBefore.slice(0, 80)}`);
      console.log(`  editor AFTER:  ${editorContentAfter.slice(0, 80)}`);
      console.log(`  ws frames (last 10):`);
      for (const f of wsFrames.slice(-10)) {
          console.log(`    [${f.t}ms ${f.dir}] ${f.event ?? ""} ${f.preview}`);
      }
      console.log(`  navigations: ${JSON.stringify(navigations)}`);
      console.log(`  request failures: ${JSON.stringify(responseEvents.filter(r => r.failure || r.status >= 400))}`);

      expect(wsFrames.length).toBeGreaterThan(0);
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vaultA, { recursive: true, force: true });
      fs.rmSync(vaultB, { recursive: true, force: true });
    }
  });
});
