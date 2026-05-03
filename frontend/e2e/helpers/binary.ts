/**
 * Spawn ./bin/jasper serve against an ephemeral data dir + free port.
 * Polls GET /api/v1/admin/status until 200 (mirrors smoke_test.go's
 * readiness pattern). Returns { proc, port, dataDir, baseURL, kill }.
 *
 * The caller MUST invoke kill() in afterEach/afterAll — leaked processes
 * exhaust the OS's launchctl/systemd handle table and cause spurious
 * test flakes on the next run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

export interface JasperHandle {
  proc: ChildProcess;
  port: number;
  dataDir: string;
  baseURL: string;
  kill: () => Promise<void>;
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

// Resolve repo root from this file: frontend/e2e/helpers/binary.ts -> ../../..
// __dirname is not defined in ES module scope, so derive it from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");

export async function spawnJasper(): Promise<JasperHandle> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "jasper-e2e-"));
  const port = await findFreePort();
  const binPath = path.join(repoRoot, "bin", "jasper");
  const proc = spawn(
    binPath,
    [
      "serve",
      "--data-dir",
      dataDir,
      "--addr",
      `127.0.0.1:${port}`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
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
    await waitForReady(baseURL, 15_000);
  } catch (e) {
    proc.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
    throw e;
  }
  const kill = async () => {
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
    await rm(dataDir, { recursive: true, force: true });
  };
  return { proc, port, dataDir, baseURL, kill };
}
