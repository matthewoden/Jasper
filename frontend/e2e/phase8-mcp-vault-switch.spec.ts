/**
 * Scripted E2E for the "MCP write in-flight during vault switch" race.
 *
 * The race window between an MCP create_note and a user clicking "switch
 * vault" is ~50ms — below reliable hand-testing threshold. Deterministic
 * timing is achieved via JASPER_MCP_TEST_DELAY=1500 (env-gated hook in
 * backend/internal/mcp/tools.go) which sleeps 1.5s before the atomic
 * write.
 *
 * Strategy:
 *   1. Two vaults A and B bootstrapped via /vault/create with mcp_enabled=true.
 *      POST /api/v1/mcp/grants seeds A:notes/projects/ and B:notes/research/.
 *   2. Spawn an MCP create_note against A's projects/race.md — DO NOT await;
 *      wait ~200ms (write is mid-throttle), then switch vault via the UI.
 *   3. After both settle, assert:
 *        (a) A's notes/projects/race.md is either fully written OR absent —
 *            never a partial scaffold-only file.
 *        (b) MCP listener is bound to B's grants — list_grants returns
 *            B's notes/research/; create_note against notes/projects/ returns
 *            no_grant (A's grants are gone).
 *        (c) StatusBar reflects vault B.
 *
 * The cancellation arm (JASPER_MCP_TEST_DELAY > drain cap) is covered by
 * TestCreateNoteRespectsTestDelay unit test. Not duplicated here — the cancel
 * path would require a flaky scripted scenario with little marginal coverage.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsP from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const JASPER_BIN = path.join(repoRoot, "bin", "jasper");


const MCP_DELAY_MS = 1500;
const SWITCH_OFFSET_MS = 200;

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


function canonVaultPath(p: string): string {
  const real = fs.realpathSync(p);
  return process.platform === "darwin" ? real.toLowerCase() : real;
}

async function waitForVault(baseURL: string, deadlineMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await fetch(`${baseURL}/api/v1/vault/current`);
      if (r.ok || r.status === 404) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`jasper not ready at ${baseURL} within ${deadlineMs}ms`);
}

async function waitForMCP(mcpPort: number, deadlineMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${mcpPort}/healthz`);
      if (r.status === 200) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`MCP /healthz did not respond within ${deadlineMs}ms: ${String(lastErr)}`);
}

interface Handle {
  proc: ChildProcess;
  baseURL: string;
  /** Ephemeral port this binary's MCP listener binds (via JASPER_MCP_PORT). */
  mcpPort: number;
  kill: () => Promise<void>;
}

async function spawnJasperWithEnv(
  appHome: string,
  env: NodeJS.ProcessEnv,
): Promise<Handle> {
  if (!fs.existsSync(JASPER_BIN)) {
    throw new Error(
      `bin/jasper missing — run \`make build\` first (CLAUDE.md §Build & embed pipeline). ` +
        `Expected at: ${JASPER_BIN}`,
    );
  }
  const port = await findFreePort();
  // Per-binary ephemeral MCP port (overrides the fixed 6684 default via
  // JASPER_MCP_PORT) so this vault-switch test runs parallel with the suite.
  const mcpPort = await findFreePort();
  const proc = spawn(JASPER_BIN, ["serve", "--bind", `127.0.0.1:${port}`], {
    env: { ...process.env, JASPER_APP_HOME: appHome, ...env, JASPER_MCP_PORT: String(mcpPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (b) => process.stderr.write(`[jasper] ${b}`));
  proc.stderr?.on("data", (b) => process.stderr.write(`[jasper] ${b}`));

  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitForVault(baseURL, 15_000);
  } catch (e) {
    proc.kill("SIGTERM");
    throw e;
  }
  return {
    proc,
    baseURL,
    mcpPort,
    // Resolve only after the process actually exits, so the next operation
    // sees the MCP port fully released.
    kill: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 3_000);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        proc.kill("SIGTERM");
      }),
  };
}


class McpClient {
  private sessionID: string | null = null;
  private nextID = 1;

  constructor(private readonly mcpUrl: string) {}

  async rpc(
    method: string,
    params: Record<string, unknown> | undefined,
    isNotification: boolean,
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;
    if (!isNotification) body.id = this.nextID++;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionID) headers["mcp-session-id"] = this.sessionID;

    const resp = await fetch(this.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const sid = resp.headers.get("mcp-session-id");
    if (sid && !this.sessionID) this.sessionID = sid;

    if (isNotification) {
      if (resp.status !== 202 && resp.status !== 200) {
        const t = await resp.text();
        throw new Error(`notification ${method} status=${resp.status}: ${t}`);
      }
      return {};
    }
    const text = await resp.text();
    const dataLine = text.split(/\r?\n/).find((l) => l.startsWith("data: "));
    if (!dataLine) {
      throw new Error(`no SSE data line (status=${resp.status}): ${text}`);
    }
    return JSON.parse(dataLine.slice("data: ".length));
  }

  async initialize(clientName: string): Promise<void> {
    const out = await this.rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0.0" },
      },
      false,
    );
    if (out.error) throw new Error(`initialize failed: ${JSON.stringify(out.error)}`);
    if (!this.sessionID) throw new Error("initialize did not return Mcp-Session-Id");
    await this.rpc("notifications/initialized", {}, true);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
  }> {
    const out = await this.rpc(
      "tools/call",
      { name, arguments: args },
      false,
    );
    if (out.error) {
      throw new Error(`tools/call ${name} RPC error: ${JSON.stringify(out.error)}`);
    }
    return out.result as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: Array<{ type: string; text?: string }>;
    };
  }
}


test.describe("Phase 8 Plan 08-24 — R4-14 MCP write during vault switch", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test("R4-14 — MCP write during vault switch commits cleanly or drains, never partial", async ({
    page,
  }) => {
    await (async () => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-14-app-"));
    const vaultARaw = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-14-A-"));
    const vaultBRaw = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-14-B-"));
    const vaultA = canonVaultPath(vaultARaw);
    const vaultB = canonVaultPath(vaultBRaw);

    let handle: Handle | undefined;
    try {
      handle = await spawnJasperWithEnv(appHome, {
        JASPER_MCP_TEST_DELAY: String(MCP_DELAY_MS),
      });

      for (const vault of [vaultA, vaultB]) {
        const createRes = await fetch(`${handle.baseURL}/api/v1/vault/create`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: vault,
            theme: "dark",
            daily_template: "",
            mcp_enabled: true,
          }),
        });
        if (!createRes.ok) {
          throw new Error(
            `vault/create ${vault} failed: ${createRes.status} ${await createRes.text()}`,
          );
        }
      }
      const openARes = await fetch(`${handle.baseURL}/api/v1/vault/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: vaultA }),
      });
      if (!openARes.ok) {
        throw new Error(`vault/open A failed: ${openARes.status} ${await openARes.text()}`);
      }

      await fsP.mkdir(path.join(vaultA, "notes", "projects"), { recursive: true });
      await fsP.mkdir(path.join(vaultB, "notes", "research"), { recursive: true });

      const grantARes = await fetch(`${handle.baseURL}/api/v1/mcp/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder_path: "projects", level: 1 }),
      });
      if (grantARes.status !== 200) {
        throw new Error(`grant A POST failed: ${grantARes.status} ${await grantARes.text()}`);
      }

      await waitForMCP(handle.mcpPort, 5_000);

      const client = new McpClient(`http://127.0.0.1:${handle.mcpPort}/mcp`);
      await client.initialize("r4-14-spec");

      await page.goto(handle.baseURL + "/");
      await expect(page.getByTestId("status-bar-vault")).toBeVisible({ timeout: 15_000 });
      const nameA = path.basename(vaultA);
      await expect(page.getByTestId("status-bar-vault")).toContainText(
        nameA.substring(0, 8),
        { timeout: 5_000 },
      );

      const expectedBody =
        "race body — first paragraph\n\n```go\nfunc main(){println(\"hello\")}\n```\n\nrace body — last paragraph\n";
      let mcpResult: {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content?: Array<{ type: string; text?: string }>;
      } | null = null;
      let mcpError: Error | null = null;
      const mcpPromise = client
        .callTool("create_note", {
          path: "projects/race.md",
          body: expectedBody,
        })
        .then((r) => {
          mcpResult = r;
        })
        .catch((e: unknown) => {
          mcpError = e instanceof Error ? e : new Error(String(e));
        });

      await page.waitForTimeout(SWITCH_OFFSET_MS);

      await page.getByTestId("status-bar-vault").click();
      await expect(page.getByRole("dialog", { name: /vault/i })).toBeVisible({
        timeout: 5_000,
      });
      await page.getByRole("tab", { name: /recent/i }).click();
      await page.getByTestId(`vault-row-${vaultB}`).click({ timeout: 5_000 });

      await mcpPromise;

      const nameB = path.basename(vaultB);
      await page.waitForFunction(
        (name) => {
          const el = document.querySelector('[data-testid="status-bar-vault"]');
          return el !== null && el.textContent !== null &&
            el.textContent.includes(name.substring(0, 8));
        },
        nameB,
        { timeout: 30_000 },
      );


      const racePath = path.join(vaultA, "notes", "projects", "race.md");
      const exists = fs.existsSync(racePath);
      if (exists) {
        const contents = await fsP.readFile(racePath, "utf8");
        expect(
          contents,
          "race.md exists but is missing the scaffold (---/tags) — partial write",
        ).toContain("tags: []");
        expect(
          contents,
          "race.md exists but is missing the body first paragraph — partial scaffold-only file",
        ).toContain("race body — first paragraph");
        expect(
          contents,
          "race.md exists but is missing the body last paragraph — body was truncated",
        ).toContain("race body — last paragraph");
        expect(
          mcpError,
          `race.md committed on disk but MCP call errored: ${mcpError?.message ?? "n/a"}`,
        ).toBeNull();
        expect(
          mcpResult?.isError,
          `race.md committed on disk but MCP tool returned isError=true: ${JSON.stringify(mcpResult)}`,
        ).toBeFalsy();
      } else {
        console.warn(
          `R4-14 took the drain-cap arm — race.md absent on disk; ` +
            `mcpError=${mcpError ? mcpError.message : "null"}, ` +
            `mcpResult.isError=${mcpResult ? String((mcpResult as { isError?: boolean }).isError) : "null"}`,
        );
      }

      const swapReadyDeadline = Date.now() + 30_000;
      let grantsReady = false;
      while (Date.now() < swapReadyDeadline) {
        try {
          const probe = await fetch(`${handle.baseURL}/api/v1/mcp/grants`);
          if (probe.status === 200) {
            grantsReady = true;
            break;
          }
        } catch {
          // socket churn during the swap
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!grantsReady) {
        throw new Error("post-swap: GET /mcp/grants never returned 200 within 30s");
      }
      const grantBRes = await fetch(`${handle.baseURL}/api/v1/mcp/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder_path: "research", level: 1 }),
      });
      if (grantBRes.status !== 200) {
        throw new Error(
          `grant B POST failed (post-switch): ${grantBRes.status} ${await grantBRes.text()}`,
        );
      }

      const clientB = new McpClient(`http://127.0.0.1:${handle.mcpPort}/mcp`);
      await waitForMCP(handle.mcpPort, 5_000);
      await clientB.initialize("r4-14-spec-post-switch");

      // The grant B POST above commits via the HTTP API's writer connection;
      // list_grants reads through the MCP server's separate WAL reader
      // connection, which can lag a just-committed write under parallel load.
      // Poll for the eventual-consistent state (deterministic — not a fixed
      // sleep). A leak of A's "projects/" grant fails immediately, so the poll
      // never masks a real cross-vault leak.
      let grantPaths: string[] = [];
      const listDeadline = Date.now() + 10_000;
      for (;;) {
        const listOut = await clientB.callTool("list_grants", {});
        expect(listOut.isError, `list_grants errored: ${JSON.stringify(listOut)}`).toBeFalsy();
        const grants = (listOut.structuredContent as {
          grants?: Array<{ path: string; tier: number }>;
        })?.grants ?? [];
        grantPaths = grants.map((g) => g.path).sort();
        expect(
          grantPaths.includes("projects"),
          `A's projects/ grant leaked into vault B after switch: ${JSON.stringify(grantPaths)}`,
        ).toBe(false);
        if (grantPaths.length === 1 && grantPaths[0] === "research") break;
        if (Date.now() >= listDeadline) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(
        grantPaths,
        "list_grants must return ONLY B's research/ grant after the switch — A's projects/ MUST NOT leak",
      ).toEqual(["research"]);

      const probeOut = await clientB.callTool("create_note", {
        path: "projects/should-not-work.md",
      });
      const probeText = JSON.stringify(probeOut);
      expect(
        probeOut.isError,
        `create_note against A-only path must fail (no_grant); got: ${probeText}`,
      ).toBeTruthy();
      expect(
        probeText,
        `expected no_grant in failure body; got: ${probeText}`,
      ).toMatch(/no_grant/);

      const statusText = await page.getByTestId("status-bar-vault").textContent();
      expect(
        statusText?.toLowerCase(),
        `StatusBar must reflect vault B; got: ${statusText}`,
      ).toContain(nameB.substring(0, 8).toLowerCase());
    } finally {
      // Await full process exit before removing the data dirs so no file
      // handles remain open (this binary's MCP port is ephemeral and private).
      await handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vaultARaw, { recursive: true, force: true });
      fs.rmSync(vaultBRaw, { recursive: true, force: true });
    }
    })();
  });
});
