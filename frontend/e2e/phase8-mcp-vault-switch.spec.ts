/**
 * Phase 8 Plan 08-24 — R4-14 scripted Playwright spec for the
 * "MCP write in-flight during a user-initiated vault switch" race.
 *
 * Background:
 *   UAT-2 Test 3 was skipped because the race window between an MCP
 *   create_note and a user clicking "switch vault" is ~50ms — below
 *   reliable hand-testing threshold. CLAUDE.md §Verification policy says
 *   the right fit for "below human reaction threshold" scenarios is a
 *   scripted E2E with deterministic timing control.
 *
 * Strategy (V-TEST-4 + V6 from 08-CONTEXT.md):
 *   1. Build with `make build` (CLAUDE.md §Build & embed pipeline).
 *   2. Launch bin/jasper with JASPER_MCP_TEST_DELAY=1500 in the env so
 *      every MCP create_note sleeps 1.5s BEFORE the atomic write. The
 *      hook is implemented in backend/internal/mcp/tools.go and is
 *      explicitly debug-only (env-gated, not documented elsewhere).
 *   3. Two vaults A and B are bootstrapped via /vault/create with
 *      mcp_enabled=true; A is opened as current. POST /api/v1/mcp/grants
 *      seeds A:notes/projects/ (Tier-1) and B:notes/research/ (Tier-1).
 *   4. Spawn an MCP create_note against A's projects/race.md — DO NOT
 *      await; capture the promise. Wait ~200ms (write is mid-throttle),
 *      then drive a vault switch via the UI (StatusBar click → vault B
 *      row).
 *   5. After both the MCP RPC and the SPA reload settle, assert:
 *        (a) on-disk state in A's notes/projects/race.md is EITHER a
 *            fully composed scaffold+body OR the file does not exist.
 *            NEVER a partial scaffold-only file (V-TEST-4 + R4-1).
 *        (b) MCP listener on 6684 is bound to B's grants — list_grants
 *            returns B's notes/research/ grant; create_note against
 *            notes/projects/ returns no_grant (A's grants are gone).
 *        (c) StatusBar reflects vault B.
 *
 * Negative-path note (out of scope, documented for the next reader):
 *   If JASPER_MCP_TEST_DELAY exceeds V6's 2-second drain cap, the swap
 *   handler MUST cancel the in-flight write via ctx.Done(). The throttle
 *   hook respects that — the create_note returns ctx.Err() and the file
 *   does NOT land. This spec stays under the cap (1.5s < 2s) so the
 *   primary scenario exercises the SUCCESS-arm of drain. The cancellation
 *   arm is covered by the throttle hook's TestCreateNoteRespectsTestDelay
 *   unit test plus this comment — adding a second flaky scripted scenario
 *   for the cancel arm is more cost than value at this stage.
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

// MCP listener binds the hardcoded port 6684 (cfg.MCP.Port default per
// D-47); playwright config pins fullyParallel=false + workers=1 so the
// port is not contested across specs.
const MCP_PORT = 6684;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;

// JASPER_MCP_TEST_DELAY widens the create_note write window to 1500ms.
// We trigger the switch at ~200ms offset, so the MCP write is mid-throttle
// for ~1.3s — well above the ~50ms human race window and well below V6's
// 2s drain cap (so the drain SUCCEEDS, not cancels).
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

// canonVaultPath mirrors backend's vault.Canonicalize() output:
// filepath.Abs → EvalSymlinks → Clean → toLowerCase (darwin only).
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

async function waitForMCP(deadlineMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${MCP_PORT}/healthz`);
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
  kill: () => void;
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
  const proc = spawn(JASPER_BIN, ["serve", "--addr", `127.0.0.1:${port}`], {
    env: { ...process.env, JASPER_APP_HOME: appHome, ...env },
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
    kill: () => {
      proc.kill("SIGTERM");
    },
  };
}

// ─── Tiny MCP StreamableHTTP client (mirrors phase8-uat.spec.ts R4-1) ────────
//
// One client object per session. Stores the Mcp-Session-Id received from
// initialize and reuses it on all subsequent calls. Returns parsed JSON-RPC
// envelopes ({result?, error?}).
class McpClient {
  private sessionID: string | null = null;
  private nextID = 1;

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

    const resp = await fetch(MCP_URL, {
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

// ─── The scenario ───────────────────────────────────────────────────────────

test.describe("Phase 8 Plan 08-24 — R4-14 MCP write during vault switch", () => {
  // The make-build smoke needs a wider per-test budget than the default
  // because the binary boots twice (initial bring-up + post-switch bring-up
  // against vault B), each ~3-5s on a warm laptop.
  test.setTimeout(120_000);

  test("R4-14 — MCP write during vault switch commits cleanly or drains, never partial", async ({
    page,
  }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-14-app-"));
    const vaultARaw = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-14-A-"));
    const vaultBRaw = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-14-B-"));
    const vaultA = canonVaultPath(vaultARaw);
    const vaultB = canonVaultPath(vaultBRaw);

    let handle: Handle | undefined;
    try {
      // ── 1. Boot binary with the throttle delay env set. ──────────────────
      handle = await spawnJasperWithEnv(appHome, {
        JASPER_MCP_TEST_DELAY: String(MCP_DELAY_MS),
      });

      // ── 2. Bootstrap both vaults with MCP enabled, open A. ───────────────
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
      // After /vault/create, current_vault is the LAST created (B). Open A.
      const openARes = await fetch(`${handle.baseURL}/api/v1/vault/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: vaultA }),
      });
      if (!openARes.ok) {
        throw new Error(`vault/open A failed: ${openARes.status} ${await openARes.text()}`);
      }

      // Pre-create the per-vault target folders. fsstore's single-level
      // mkdir policy requires the immediate parent to exist before a
      // create_note targets it. Both vaults need their own folder; the
      // grant + later assertions reference these paths.
      await fsP.mkdir(path.join(vaultA, "notes", "projects"), { recursive: true });
      await fsP.mkdir(path.join(vaultB, "notes", "research"), { recursive: true });

      // ── 3. Seed grants: A:projects/ and B:research/. ─────────────────────
      // Grant must be POSTed against the CURRENTLY-OPEN vault (A), then
      // post-switch B's grant is seeded against B. We seed A's grant now;
      // B's grant we seed after the switch via list_grants assertion logic.
      const grantARes = await fetch(`${handle.baseURL}/api/v1/mcp/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder_path: "projects", level: 1 }),
      });
      if (grantARes.status !== 200) {
        throw new Error(`grant A POST failed: ${grantARes.status} ${await grantARes.text()}`);
      }

      // Wait for the MCP listener — startMCP fires the goroutine inside
      // a.startMCP; healthz responds once Accept() is ready.
      await waitForMCP(5_000);

      // ── 4. Initialize MCP session. ───────────────────────────────────────
      const client = new McpClient();
      await client.initialize("r4-14-spec");

      // ── 5. Navigate to the app — see vault A's main shell. ───────────────
      await page.goto(handle.baseURL + "/");
      await expect(page.getByTestId("status-bar-vault")).toBeVisible({ timeout: 15_000 });
      const nameA = path.basename(vaultA);
      await expect(page.getByTestId("status-bar-vault")).toContainText(
        nameA.substring(0, 8),
        { timeout: 5_000 },
      );

      // ── 6. Fire the MCP create_note against A WITHOUT awaiting it. ───────
      // The throttle keeps the write mid-flight for 1.5s. We treat the
      // promise as a resolved-eventually channel; any error is captured
      // and asserted below as part of the partial-file invariant.
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

      // ── 7. ~200ms in, trigger the UI switch via StatusBar click → B. ─────
      await page.waitForTimeout(SWITCH_OFFSET_MS);

      // Click StatusBar to open vault picker in switch mode.
      await page.getByTestId("status-bar-vault").click();
      await expect(page.getByRole("dialog", { name: /vault/i })).toBeVisible({
        timeout: 5_000,
      });
      // Recent tab → vault B's row.
      await page.getByRole("tab", { name: /recent/i }).click();
      await page.getByTestId(`vault-row-${vaultB}`).click({ timeout: 5_000 });

      // ── 8. Await both: the MCP RPC and the SPA settle on B. ──────────────
      await mcpPromise;

      // The SPA reload reflects vault B in the StatusBar; backend has
      // already torn down A's MCP listener and brought up B's listener on
      // 6684 by the time the new StatusBar text is rendered.
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

      // ── 9. ASSERT V-TEST-4 / R4-14 invariants. ───────────────────────────

      // (a) On-disk in A: EITHER fully composed scaffold+body OR file absent.
      //     NEVER a partial scaffold-only file (R4-1 atomic-create invariant).
      const racePath = path.join(vaultA, "notes", "projects", "race.md");
      const exists = fs.existsSync(racePath);
      if (exists) {
        const contents = await fsP.readFile(racePath, "utf8");
        // Must contain the scaffold tags block AND the body's first + last
        // paragraphs verbatim. Absence of the body would mean a partial
        // (scaffold-only) file — the R4-1 regression class.
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
        // The MCP RPC must have reported success on this arm.
        expect(
          mcpError,
          `race.md committed on disk but MCP call errored: ${mcpError?.message ?? "n/a"}`,
        ).toBeNull();
        expect(
          mcpResult?.isError,
          `race.md committed on disk but MCP tool returned isError=true: ${JSON.stringify(mcpResult)}`,
        ).toBeFalsy();
      } else {
        // Drain-cap path: V6's 2s cap engaged before the throttle returned,
        // ctx canceled the write, file does not land. The MCP RPC may have
        // returned a ctx-canceled error or the SDK may have surfaced a
        // transport-level disconnect; either is acceptable on this arm.
        // We do NOT fail on a non-null mcpError here because the test's
        // primary invariant is "no partial file", and that is upheld by
        // the absence of the file on disk. Document the path the run took
        // so a future flake investigator can correlate with binary logs.
        console.warn(
          `R4-14 took the drain-cap arm — race.md absent on disk; ` +
            `mcpError=${mcpError ? mcpError.message : "null"}, ` +
            `mcpResult.isError=${mcpResult ? String((mcpResult as { isError?: boolean }).isError) : "null"}`,
        );
      }

      // (b) MCP listener is bound to B's grants. Seed B's grant FIRST (the
      //     /vault/switch tore down the A-vault grants set; B starts empty).
      //
      //     The StatusBar text flipping to B's display name does NOT prove
      //     the post-swap bootPerVaultSubsystems has completed — the SPA
      //     reload + new WS connect can settle BEFORE B's new MCP ACL is
      //     wired into the API server. We poll the GET grants endpoint
      //     until it returns 200 (it returns 500 "database is closed"
      //     while A's pair has shut down and B's pair has not yet opened).
      //     This is the load-bearing "post-swap readiness" gate.
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

      // Re-initialize MCP — the post-swap listener is a new server SDK
      // instance and the prior session-id is gone.
      const clientB = new McpClient();
      await waitForMCP(5_000);
      await clientB.initialize("r4-14-spec-post-switch");

      // list_grants returns ONLY B's grants — no A leaking through.
      const listOut = await clientB.callTool("list_grants", {});
      expect(listOut.isError, `list_grants errored: ${JSON.stringify(listOut)}`).toBeFalsy();
      const grants = (listOut.structuredContent as {
        grants?: Array<{ path: string; tier: number }>;
      })?.grants ?? [];
      const grantPaths = grants.map((g) => g.path).sort();
      expect(
        grantPaths,
        "list_grants must return ONLY B's research/ grant after the switch — A's projects/ MUST NOT leak",
      ).toEqual(["research"]);

      // create_note against A-only path (projects/) — must be forbidden,
      // proves the listener rebound atomically with the swap to B's ACL.
      const probeOut = await clientB.callTool("create_note", {
        path: "projects/should-not-work.md",
      });
      // Either tool returns isError + a no_grant message in content, or
      // the structuredContent surfaces the failure mode. Either is
      // acceptable; the assertion is: this DID NOT succeed.
      const probeText = JSON.stringify(probeOut);
      expect(
        probeOut.isError,
        `create_note against A-only path must fail (no_grant); got: ${probeText}`,
      ).toBeTruthy();
      expect(
        probeText,
        `expected no_grant in failure body; got: ${probeText}`,
      ).toMatch(/no_grant/);

      // (c) StatusBar shows B (already asserted above by waitForFunction).
      const statusText = await page.getByTestId("status-bar-vault").textContent();
      expect(
        statusText?.toLowerCase(),
        `StatusBar must reflect vault B; got: ${statusText}`,
      ).toContain(nameB.substring(0, 8).toLowerCase());
    } finally {
      handle?.kill();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vaultARaw, { recursive: true, force: true });
      fs.rmSync(vaultBRaw, { recursive: true, force: true });
    }
  });
});
