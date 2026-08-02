/**
 * A grant must tint the granted folder AND every descendant, via an ancestor walk
 * rather than a direct-level check.
 *
 * No pixel assertions — data-ai-level's presence is the load-bearing contract and
 * CSS handles the paint.
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
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`jasper not ready at ${baseURL} within ${deadlineMs}ms`);
}

interface VaultHandle {
  proc: ChildProcess;
  baseURL: string;
  kill: () => void;
}

async function spawnJasper(appHome: string): Promise<VaultHandle> {
  if (!fs.existsSync(JASPER_BIN)) {
    throw new Error(`bin/jasper missing — run \`make build\` first. Expected: ${JASPER_BIN}`);
  }
  const port = await findFreePort();
  const proc = spawn(JASPER_BIN, ["serve", "--bind", `127.0.0.1:${port}`], {
    env: { ...process.env, JASPER_APP_HOME: appHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
      path: vaultDir, theme: "dark", daily_template: "",
    }),
  });
  if (!res.ok) throw new Error(`vault/create failed: ${res.status} ${await res.text()}`);
}

async function openVault(baseURL: string, vaultPath: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/v1/vault/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: vaultPath }),
  });
  if (!res.ok) throw new Error(`vault/open failed: ${res.status} ${await res.text()}`);
}

function canonVaultPath(p: string): string {
  const real = fs.realpathSync(p);
  return process.platform === "darwin" ? real.toLowerCase() : real;
}

test.describe("violet folder tint via data-ai-level", () => {
  test("granted folder + descendant note both get data-ai-level on the row element", async ({
    page,
  }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-6-app-"));
    const vault = canonVaultPath(
      fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-6-vault-")),
    );

    const notesDir = path.join(vault, "notes");
    fs.mkdirSync(path.join(notesDir, "projects"), { recursive: true });
    fs.writeFileSync(
      path.join(notesDir, "projects", "note-inside.md"),
      "# note-inside\n\ninside the granted folder.\n",
      "utf8",
    );

    let handle: VaultHandle | undefined;
    try {
      handle = await spawnJasper(appHome);
      await bootstrapVault(handle.baseURL, vault);
      await openVault(handle.baseURL, vault);

      await page.goto(handle.baseURL + "/");
      await expect(page.getByTestId("status-bar")).toBeVisible({ timeout: 10_000 });
      const projectsRow = page.locator(
        '[data-tree-row="projects"][data-tree-row-kind="folder"]',
      );
      await expect(projectsRow).toBeVisible({ timeout: 5_000 });

      await expect(projectsRow).not.toHaveAttribute("data-ai-level", /.+/);

      await projectsRow.click();
      const noteRow = page
        .locator('[data-tree-row-kind="note"]')
        .filter({ hasText: "note-inside" });
      await expect(noteRow).toBeVisible({ timeout: 5_000 });
      await expect(noteRow).not.toHaveAttribute("data-ai-level", /.+/);

      const grant = await fetch(`${handle.baseURL}/api/v1/mcp/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder_path: "projects", level: 1 }),
      });
      expect(grant.status, "grant POST status").toBe(200);

      await expect(projectsRow).toHaveAttribute("data-ai-level", "1", {
        timeout: 5_000,
      });
      await expect(noteRow).toHaveAttribute("data-ai-level", "1", {
        timeout: 5_000,
      });

      const revoke = await fetch(
        `${handle.baseURL}/api/v1/mcp/grants?path=projects`,
        { method: "DELETE" },
      );
      expect([200, 204]).toContain(revoke.status);

      await expect(projectsRow).not.toHaveAttribute("data-ai-level", /.+/, {
        timeout: 5_000,
      });
      await expect(noteRow).not.toHaveAttribute("data-ai-level", /.+/, {
        timeout: 5_000,
      });
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});
