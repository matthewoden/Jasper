/**
 * --vault flag regression spec for the serve subcommand.
 *
 * Pre-fix: serveCmd had DisableFlagParsing=true so the --vault flag was
 * never parsed, producing "flag provided but not defined: -vault".
 *
 * Asserts the server boots cleanly and /api/v1/admin/status returns 200.
 * Backend-only smoke (no browser).
 *
 * NOTE: helpers inlined per file — Playwright's transformer did not accept
 * a shared sibling .ts module import.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  kill: () => void;
}

async function spawnJasper(appHome: string, extraArgs: string[] = []): Promise<VaultHandle> {
  if (!fs.existsSync(JASPER_BIN)) {
    throw new Error(
      `bin/jasper missing — run \`make build\` first. Expected at: ${JASPER_BIN}`,
    );
  }
  const port = await findFreePort();
  const proc = spawn(
    JASPER_BIN,
    ["serve", "--bind", `127.0.0.1:${port}`, ...extraArgs],
    {
      env: { ...process.env, JASPER_APP_HOME: appHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout?.on("data", (b) => process.stderr.write(`[jasper] ${b}`));
  proc.stderr?.on("data", (b) => process.stderr.write(`[jasper] ${b}`));

  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitForVaultEndpoint(baseURL, 15_000);
  } catch (e) {
    proc.kill("SIGTERM");
    throw e;
  }
  return { proc, baseURL, kill: () => { proc.kill("SIGTERM"); } };
}

async function bootstrapVault(baseURL: string, vaultDir: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/v1/vault/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: vaultDir,
      theme: "dark",
      daily_template: "",
      mcp_enabled: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`vault/create failed for ${vaultDir}: ${res.status} ${await res.text()}`);
  }
}

function canonVaultPath(p: string): string {
  const real = fs.realpathSync(p);
  return process.platform === "darwin" ? real.toLowerCase() : real;
}

test.describe("Phase 8 R4-1 — --vault on serve", () => {
  test("bin/jasper serve --vault <path> boots and serves /admin/status", async () => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-1-app-"));
    const vault = canonVaultPath(
      fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-1-vault-")),
    );

    let bootHandle: VaultHandle | undefined;
    try {
      bootHandle = await spawnJasper(appHome);
      await bootstrapVault(bootHandle.baseURL, vault);
    } finally {
      bootHandle?.kill();
    }
    await new Promise((r) => setTimeout(r, 200));

    let handle: VaultHandle | undefined;
    try {
      handle = await spawnJasper(appHome, ["--vault", vault]);

      const resp = await fetch(`${handle.baseURL}/api/v1/admin/status`);
      expect(resp.ok, `admin/status not 2xx: ${resp.status}`).toBe(true);

      const cur = await fetch(`${handle.baseURL}/api/v1/vault/current`);
      expect(cur.ok).toBe(true);
      const curBody = (await cur.json()) as { vault?: { path?: string } };
      expect(curBody.vault?.path).toBe(vault);
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});
