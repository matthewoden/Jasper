/**
 * Search "123" finds note-00123 + hyphenated tokens don't 500.
 *
 * Two bugs in the same FTS5 stack:
 *   (a) "123" was prefix-wrapped to "123*" but the unicode61 tokenizer with
 *       tokenchars '_-' indexes "note-00123" as ONE token, so the prefix
 *       match never fired. Fix: title/path LIKE backstop.
 *   (b) "note-00123" prefix-wrapped to "note-00123*"; FTS5 query grammar
 *       parses '-' as a binary operator, erroring with "no such column:
 *       00123". Fix: quote hyphen/underscore tokens before wrapping.
 *
 * Drives the full path: seeded notes → indexer → search API → SPA modal
 * render. Mock-the-API style wouldn't catch the FTS5 query syntax issue.
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

test.describe("search partial number + hyphen escape", () => {
  test("typing '123' surfaces note-00123; 'note-00123' doesn't 500", async ({ page }) => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-3-app-"));
    const vault = canonVaultPath(fs.mkdtempSync(path.join(os.tmpdir(), "jasper-r4-3-vault-")));

    let handle: VaultHandle | undefined;
    try {
      const notesDir = path.join(vault, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      for (const name of ["note-00123", "note-00124", "note-00125"]) {
        fs.writeFileSync(
          path.join(notesDir, `${name}.md`),
          `# ${name}\n\nbody for ${name}.\n`,
          "utf8",
        );
      }

      handle = await spawnJasper(appHome);
      await bootstrapVault(handle.baseURL, vault);
      await openVault(handle.baseURL, vault);

      const deadline = Date.now() + 8_000;
      let r123: Response;
      let r123Body: { results: Array<{ title: string; path: string }> };
      while (true) {
        r123 = await fetch(`${handle.baseURL}/api/v1/search?q=123&limit=10`);
        if (r123.ok) {
          r123Body = await r123.json();
          if (r123Body.results.length > 0) break;
        }
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(r123!.status, "search?q=123 status").toBe(200);
      const matched123 = r123Body!.results.some(
        (r) => r.title === "note-00123" || r.path === "note-00123.md",
      );
      expect(
        matched123,
        `expected note-00123 in q=123 results; got ${JSON.stringify(r123Body!.results.map((r) => r.title))}`,
      ).toBe(true);

      const rHyphen = await fetch(
        `${handle.baseURL}/api/v1/search?q=${encodeURIComponent("note-00123")}&limit=3`,
      );
      expect(rHyphen.status, "search?q=note-00123 status").toBe(200);
      const rHyphenBody = (await rHyphen.json()) as { results: Array<{ title: string }> };
      expect(rHyphenBody.results.some((r) => r.title === "note-00123")).toBe(true);

      await page.goto(handle.baseURL + "/");
      await expect(page.getByTestId("status-bar")).toBeVisible({ timeout: 10_000 });

      const modKey = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modKey}+Shift+F`);

      const searchInput = page.getByRole("textbox", { name: "Search notes" });
      await expect(searchInput).toBeVisible({ timeout: 3_000 });
      await searchInput.fill("123");

      await expect(page.getByText("note-00123").first()).toBeVisible({
        timeout: 5_000,
      });
    } finally {
      handle?.kill();
      fs.rmSync(appHome, { recursive: true, force: true });
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});
