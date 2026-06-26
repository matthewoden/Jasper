/**
 * Spawn ./bin/jasper serve against an ephemeral data dir + free port.
 * Polls GET /api/v1/admin/status until 200 (mirrors smoke_test.go's
 * readiness pattern). Returns { proc, port, dataDir, baseURL, kill, restart }.
 *
 * The caller MUST invoke kill() in afterEach/afterAll — leaked processes
 * exhaust the OS's launchctl/systemd handle table and cause spurious
 * test flakes on the next run.
 *
 * restart() kills the running binary and spawns a new one against the SAME
 * data directory on the SAME port. This allows browser tabs to reconnect
 * autonomously via their WS onclose → reconnect timer (useSessionSync
 * connects to window.location.host, so the port must match).
 *
 * Same-port restart rationale vs. new-port: useSessionSync builds the WS URL
 * from window.location.host at mount time. A new port would require navigating
 * all tabs to the new baseURL, which defeats the purpose of testing autonomous
 * reconnection. We therefore reuse the same port.
 *
 * TIME_WAIT risk: on macOS and Linux, the OS holds a port in TIME_WAIT for
 * ~4× MSL (up to 60s on some systems) after graceful close. In practice the
 * binary binds SO_REUSEADDR so immediate rebind works. If flakiness is
 * observed, add a retry loop in the spawn path — see the `waitForReady` loop
 * which already has a 15s window.
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

async function waitForReady(baseURL: string, deadlineMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await fetch(`${baseURL}/api/v1/admin/status`);
      if (r.status === 200) return;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`jasper did not become ready at ${baseURL} within ${deadlineMs}ms`);
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
async function spawnJasperInternal(opts: { dataDir?: string; port?: number; mcpPort?: number; ownsDataDir: boolean; env?: NodeJS.ProcessEnv }): Promise<JasperHandle> {
  const dataDir = opts.dataDir ?? await mkdtemp(path.join(tmpdir(), "jasper-e2e-"));
  const port = opts.port ?? await findFreePort();
  // Each binary binds its MCP listener to its own ephemeral port (via the
  // JASPER_MCP_PORT override) instead of the fixed default 6684. This removes
  // the shared-singleton contention that previously required a cross-process
  // file lock, so MCP tests run fully parallel and deterministic.
  const mcpPort = opts.mcpPort ?? await findFreePort();
  const ownsDataDir = opts.ownsDataDir;
  const binPath = path.join(repoRoot, "bin", "jasper");
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
      env: { ...process.env, ...(opts.env ?? {}), JASPER_MCP_PORT: String(mcpPort) },
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
    await waitForReady(baseURL, READINESS_TIMEOUT_MS);
  } catch (e) {
    proc.kill("SIGTERM");
    if (ownsDataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
    throw e;
  }

  const kill = async () => {
    await killProcess(proc);
    if (ownsDataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  };

  const restart = async (): Promise<JasperHandle> => {
    await killProcess(proc);
    await new Promise((r) => setTimeout(r, 200));
    return spawnJasperInternal({ dataDir, port, mcpPort, ownsDataDir, env: opts.env });
  };

  return { proc, port, mcpPort, dataDir, baseURL, kill, restart };
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
