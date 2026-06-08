/**
 * Phase 9 UAT — vault storage path unification (F2 close-out).
 *
 * Per CONVENTIONS.md §"Verification policy: E2E before human UAT" + §"Flaky
 * tests are bugs" (commit 67cf41e): this spec runs against the live
 * `bin/jasper` binary (built by `make build`) and uses ONLY deterministic
 * synchronization points — no polling loops with timeouts.
 *
 * Deterministic sync points used here:
 *   - Test 1: POST /api/v1/setup returning 200 is the sync point for
 *             post-setup filesystem assertions (.jasper/ dir + config.json
 *             exist; storage/ does not exist). app.db is NOT asserted here
 *             because CreateVault no longer creates the DB at submit time
 *             (Phase 9 D-04, Plan 03a) — the DB is created on first server
 *             boot into the new vault, which a different code path triggers.
 *
 *   - Test 2: spawnJasper's `waitForReady` (HTTP probe of
 *             /api/v1/admin/status) is the sync point for post-boot
 *             assertions. After it resolves the binary has run migrations
 *             against <vault>/.jasper/app.db.
 *
 *   - Test 3 (sqlite3-gated): same sync point as Test 2; the sqlite3
 *             query is a one-shot read against the DB created during boot.
 *
 * Acceptance source: .planning/notes/F2-two-db-assessment.md and
 * .planning/phases/09-vault-storage-path-unification-f2/09-05-PLAN.md.
 */
import { test, expect } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function fileSize(p: string): Promise<number> {
  const stat = await fs.stat(p);
  return stat.size;
}

test.describe("Phase 9 F2 — vault path unification (@phase9-f2)", () => {
  test.describe("@phase9-f2-1 — POST /api/v1/setup writes .jasper/, no storage/", () => {
    let jasper: JasperHandle;

    test.beforeAll(async () => {
      // No dataDir override — vault-picker mode. spawnJasper allocates an
      // ephemeral dataDir for the picker's own state; the test uses a
      // separate target directory below.
      jasper = await spawnJasper();
    });

    test.afterAll(async () => {
      if (jasper) await jasper.kill();
    });

    test("F2-1: setup wizard writes config.json under .jasper/ and never creates storage/", async () => {
      const suffix = `jasper-e2e-phase9-f2-1-${Date.now()}-${Math.floor(
        Math.random() * 1e6,
      )}`;
      const tildePath = `~/${suffix}`;
      const expandedPath = path.join(os.homedir(), suffix);

      try {
        const setupResp = await fetch(jasper.baseURL + "/api/v1/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            data_dir: tildePath,
            theme: "dark",
            mcp_enabled: false,
            mcp_grants: [],
            daily_template: "# {{date}}\n\n",
            create_today_daily_note: false,
          }),
        });
        expect(
          setupResp.status,
          `Expected 200 from /api/v1/setup; got ${setupResp.status}`,
        ).toBe(200);

        // DETERMINISTIC ASSERTIONS (no polling):
        // POST /setup has completed (200). CreateVault wrote the per-vault
        // .jasper/ directory + config.json synchronously inside that
        // request. Filesystem state is finalized.
        expect(
          await dirExists(path.join(expandedPath, ".jasper")),
          `Expected ${expandedPath}/.jasper/ to exist after POST /setup`,
        ).toBe(true);
        expect(
          await fileExists(path.join(expandedPath, ".jasper", "config.json")),
          `Expected ${expandedPath}/.jasper/config.json to exist after POST /setup`,
        ).toBe(true);
        expect(
          await dirExists(path.join(expandedPath, "storage")),
          `Expected ${expandedPath}/storage/ to NOT exist (Phase 9 closes legacy path)`,
        ).toBe(false);
        expect(
          await fileExists(path.join(expandedPath, "storage", "config.json")),
          `Expected ${expandedPath}/storage/config.json to NOT exist`,
        ).toBe(false);
        // NOTE: app.db is asserted in Test 2 (@phase9-f2-2), not here. The
        // current submit pipeline creates the DB on first server boot into
        // the new vault, not inside the POST /setup handler. Polling for
        // app.db here would be flaky per CONVENTIONS.md "Flaky tests are
        // bugs."
      } finally {
        await fs.rm(expandedPath, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  test.describe("@phase9-f2-2 — fresh boot creates .jasper/app.db, no storage/", () => {
    let vaultPath: string;
    let jasper: JasperHandle | null = null;

    test.beforeAll(async () => {
      vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), "jasper-e2e-phase9-f2-2-"));
      await fs.mkdir(path.join(vaultPath, "notes"), { recursive: true });
      // Intentionally do NOT pre-create .jasper/ — the boot path is what
      // we're validating.
      jasper = await spawnJasper({ dataDir: vaultPath });
      // spawnJasper resolves only after waitForReady() observes a 200 from
      // /api/v1/admin/status — that IS the deterministic sync point.
    });

    test.afterAll(async () => {
      if (jasper) await jasper.kill();
      // spawnJasper with dataDir set leaves cleanup to the caller.
      await fs.rm(vaultPath, { recursive: true, force: true }).catch(() => {});
    });

    test("F2-2: boot creates .jasper/app.db (migrations ran); storage/ is never created", async () => {
      const jasperDir = path.join(vaultPath, ".jasper");
      const dbPath = path.join(jasperDir, "app.db");

      expect(
        await dirExists(jasperDir),
        `Expected ${jasperDir} to exist after binary boot`,
      ).toBe(true);
      expect(
        await fileExists(dbPath),
        `Expected ${dbPath} to exist after binary boot (migrations create it)`,
      ).toBe(true);
      expect(
        await fileSize(dbPath),
        `Expected ${dbPath} to be non-empty (migrations populate schema_migrations)`,
      ).toBeGreaterThan(0);
      expect(
        await dirExists(path.join(vaultPath, "storage")),
        `Expected ${vaultPath}/storage/ to NOT exist (Phase 9 closes legacy path)`,
      ).toBe(false);
    });

    test("F2-3 (@phase9-f2-3, sqlite3-gated): schema_migrations populated in .jasper/app.db", async () => {
      const dbPath = path.join(vaultPath, ".jasper", "app.db");
      let sqlite3Available = false;
      try {
        execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
        sqlite3Available = true;
      } catch {
        // sqlite3 not on PATH — skip (the file-existence + size check in
        // F2-2 is the structural assertion; this is a defense-in-depth
        // assertion that migrations actually ran against the new path).
      }
      if (!sqlite3Available) {
        console.log("[phase9-f2-3] sqlite3 not on PATH — skipping migrations-count check");
        return;
      }
      const out = execFileSync("sqlite3", [
        dbPath,
        "SELECT count(*) FROM schema_migrations",
      ])
        .toString()
        .trim();
      const count = Number.parseInt(out, 10);
      expect(
        Number.isFinite(count) && count > 0,
        `Expected schema_migrations rowcount > 0 in ${dbPath}; got: ${JSON.stringify(out)}`,
      ).toBe(true);
    });
  });
});
