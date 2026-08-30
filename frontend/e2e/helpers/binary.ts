/**
 * Spawn ./bin/jasper serve against an ephemeral data dir + free port, polling
 * GET /api/v1/admin/status until 200.
 *
 * Run `make build` first, NOT `npm run build` — the binary serves an EMBEDDED
 * copy of the frontend, so a Vite-only build leaves the page stale.
 *
 * The caller MUST invoke kill() in afterEach/afterAll — leaked processes exhaust
 * the OS handle table and cause spurious flakes on the next run.
 *
 * restart() reuses the SAME port deliberately: useSessionSync builds its WS URL
 * from window.location.host at mount, so a new port would force navigating every
 * tab and defeat the point of testing autonomous reconnection. The binary binds
 * SO_REUSEADDR, so TIME_WAIT does not block the immediate rebind.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

// Boot-readiness window. Generous (30s) so CPU contention at workers:4 — where
// several binaries boot simultaneously (migrations + incremental reindex) —
// does not produce false "did not become ready" failures.
const READINESS_TIMEOUT_MS = 30_000;

/**
 * Pass-through retained for call-site compatibility. The cross-process file
 * lock that previously serialized access to the fixed MCP port 6684 is no
 * longer needed: each spawned binary now binds its MCP listener to its own
 * ephemeral port (see spawnJasperInternal / JASPER_MCP_PORT), so there is no
 * shared singleton to serialize. New tests should NOT wrap with this; it exists
 * only so existing call sites keep working until they are simplified away.
 */
export async function withMcpPortLock<T>(fn: () => Promise<T>): Promise<T> {
  return await fn();
}

export interface JasperHandle {
  proc: ChildProcess;
  port: number;
  /** Ephemeral port this binary's MCP listener binds (via JASPER_MCP_PORT). */
  mcpPort: number;
  dataDir: string;
  baseURL: string;
  kill: () => Promise<void>;
  /**
   * Kill the running binary and spawn a fresh one against the SAME
   * data directory on the SAME port so reconnect tests can prove that
   * tabs re-establish the WS without needing to navigate.
   *
   * Returns a NEW JasperHandle (with the same port and dataDir).
   * The old handle's kill() must NOT be called after restart() —
   * the new handle's kill() owns cleanup including dataDir removal.
   */
  restart: () => Promise<JasperHandle>;
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("could not allocate free port"));
      }
    });
  });
}

async function waitForReadyOrExit(
  proc: ChildProcess,
  baseURL: string,
  deadlineMs: number,
): Promise<void> {
  let exited = false;
  let exitInfo = "";
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exited = true;
    exitInfo = `code=${code} signal=${signal}`;
  };
  proc.once("exit", onExit);
  try {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      // If the binary lost the port race it exits immediately; abort fast and
      // let the caller retry on a fresh port instead of polling a dead process
      // for the full deadline.
      if (exited) {
        throw new Error(`jasper exited before becoming ready at ${baseURL} (${exitInfo})`);
      }
      try {
        const r = await fetch(`${baseURL}/api/v1/admin/status`);
        if (r.status === 200) return;
      } catch {
        // not yet listening
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`jasper did not become ready at ${baseURL} within ${deadlineMs}ms`);
  } finally {
    proc.removeListener("exit", onExit);
  }
}

async function killProcess(proc: ChildProcess): Promise<void> {
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 3_000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");

/**
 * Spawn a Jasper binary against the given dataDir and port.
 * If dataDir is not provided, an ephemeral tmpdir is created.
 * If port is not provided, a free port is allocated.
 *
 * env: optional environment overlay merged on top of process.env. Used by
 * the deterministic-timing MCP race spec to set JASPER_MCP_TEST_DELAY
 * without leaking into unrelated tests. Pass undefined to inherit
 * process.env verbatim.
 */
async function spawnJasperInternal(opts: { dataDir?: string; port?: number; mcpPort?: number; ownsDataDir: boolean; appHome?: string; env?: NodeJS.ProcessEnv }): Promise<JasperHandle> {
  const dataDir = opts.dataDir ?? await mkdtemp(path.join(tmpdir(), "jasper-e2e-"));
  const ownsDataDir = opts.ownsDataDir;
  // Without this the spawned binary falls through to the developer's real
  // ~/.jasper/app.json and evicts their genuine recent vaults. Allocated per
  // handle and reused across restart() so vault state survives a restart.
  const ownsAppHome = opts.appHome === undefined;
  const appHome = opts.appHome ?? await mkdtemp(path.join(tmpdir(), "jasper-e2e-apphome-"));
  const binPath = path.join(repoRoot, "bin", "jasper");

  // Bounded spawn-retry. findFreePort() binds :0 then closes the socket before
  // returning the port, leaving a TOCTOU window where another parallel worker
  // (or this call's second findFreePort) can claim the same port before the
  // binary binds it. The loser exits immediately; retry on freshly-allocated
  // ports instead of surfacing a flake (harness header: "add a retry loop in
  // the spawn path"). Each binary also binds its MCP listener to its own
  // ephemeral port via JASPER_MCP_PORT, so MCP tests stay fully parallel.
  // Caller-pinned ports (restart()) are kept as-is and not retried-randomized.
  const MAX_ATTEMPTS = 5;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const port = opts.port ?? await findFreePort();
    const mcpPort = opts.mcpPort ?? await findFreePort();
    const proc = spawn(
      binPath,
      [
        "serve",
        "--vault",
        dataDir,
        "--bind",
        `127.0.0.1:${port}`,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, JASPER_APP_HOME: appHome, ...(opts.env ?? {}), JASPER_MCP_PORT: String(mcpPort) },
      },
    );
    proc.stdout?.on("data", (b) => {
      process.stderr.write(`[jasper] ${b}`);
    });
    proc.stderr?.on("data", (b) => {
      process.stderr.write(`[jasper] ${b}`);
    });
    const baseURL = `http://127.0.0.1:${port}`;
    try {
      await waitForReadyOrExit(proc, baseURL, READINESS_TIMEOUT_MS);
    } catch (e) {
      lastErr = e;
      // Skip the SIGTERM/await if the process already exited (the common
      // bind-race case) so retries stay fast.
      if (proc.exitCode === null && proc.signalCode === null) {
        await killProcess(proc);
      }
      // Re-allocating ports cannot help a caller-pinned port — fail fast.
      if (opts.port !== undefined) break;
      continue;
    }

    const kill = async () => {
      await killProcess(proc);
      if (ownsDataDir) {
        await rm(dataDir, { recursive: true, force: true });
      }
      if (ownsAppHome) {
        await rm(appHome, { recursive: true, force: true });
      }
    };

    const restart = async (): Promise<JasperHandle> => {
      await killProcess(proc);
      await new Promise((r) => setTimeout(r, 200));
      return spawnJasperInternal({ dataDir, port, mcpPort, ownsDataDir, appHome, env: opts.env });
    };

    return { proc, port, mcpPort, dataDir, baseURL, kill, restart };
  }

  if (ownsDataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
  if (ownsAppHome) {
    await rm(appHome, { recursive: true, force: true });
  }
  throw lastErr ?? new Error(`jasper did not become ready after ${MAX_ATTEMPTS} attempts`);
}

export interface SpawnOpts {
  /**
   * Provide an existing data directory to reuse (e.g., for migration tests
   * that need to stop the binary, mutate disk files, and restart against the
   * same vault). When provided, the caller owns the dataDir lifecycle — it
   * will NOT be deleted on kill(). Use kill() on the new handle only.
   */
  dataDir?: string;
  /**
   * Optional environment overlay (merged on top of process.env). Used by the
   * deterministic-timing MCP race spec to set JASPER_MCP_TEST_DELAY without
   * leaking into unrelated tests. Empty/undefined inherits process.env verbatim.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn a Jasper binary against an optional existing data directory.
 *
 * CLAUDE.md §Build & embed pipeline enforcement: this function fails fast with
 * a clear error if `bin/jasper` is missing — the caller must run `make build`
 * first. This prevents mysterious 404s from a stale binary or a missing binary
 * masking as a test failure.
 */
export async function spawnJasper(opts: SpawnOpts = {}): Promise<JasperHandle> {
  const { existsSync } = await import("node:fs");
  const JASPER_BIN = path.join(repoRoot, "bin", "jasper");
  if (!existsSync(JASPER_BIN)) {
    throw new Error(
      `bin/jasper missing — run \`make build\` first (CLAUDE.md §Build & embed pipeline). ` +
        `Expected at: ${JASPER_BIN}`,
    );
  }

  if (opts.dataDir !== undefined) {
    return spawnJasperInternal({ dataDir: opts.dataDir, ownsDataDir: false, env: opts.env });
  }
  return spawnJasperInternal({ ownsDataDir: true, env: opts.env });
}
