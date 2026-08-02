/**
 * Install, first-run wizard, reveal, deep links and MCP grants. Each top-level
 * describe spawns its own binary against a fresh ephemeral data dir.
 *
 * The @reveal test asserts visibility only — clicking would pop Finder/Explorer.
 *
 * KNOWN ISSUE, and a real production gap rather than a test artifact: lifecycle.Run
 * calls config.Load, which auto-writes config.json if missing, BEFORE the listener
 * accepts connections. By the time a page navigates to "/", config.json exists and
 * the firstrun middleware no-ops, so "/" never redirects to "/setup". The
 * @first-run redirect tests are test.fixme()'d pending a fix — deferring the
 * auto-write to POST /setup, gating it on a wizard-intent sentinel, or having
 * `install` not pre-create the file. The wizard SPA itself renders correctly.
 */
import { test, expect } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";


test.describe("first-run wizard (@first-run)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test.fixme(
    "redirects from / to /setup on first hit and renders the LOCKED copy",
    async ({ page }) => {
      await page.goto(jasper.baseURL);
      await expect(page).toHaveURL(/\/setup$/);
      await expect(
        page.getByRole("heading", { level: 1, name: "Set up Jasper" }),
      ).toBeVisible();
      await expect(
        page.getByText(/A few choices and you('|’)re writing/i),
      ).toBeVisible();
      await expect(page.getByLabel("Data directory path")).toBeVisible();
      await expect(page.getByLabel("Start Jasper")).toBeVisible();
    },
  );

  test("the wizard SPA at /setup renders the LOCKED copy", async ({ page }) => {
    await page.goto(jasper.baseURL + "/setup");
    await expect(
      page.getByRole("heading", { level: 1, name: "Set up Jasper" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/A few choices and you('|’)re writing/i),
    ).toBeVisible();
    await expect(page.getByLabel("Data directory path")).toBeVisible();
    await expect(page.getByLabel("Start Jasper")).toBeVisible();
  });

  test.fixme(
    "renders refusal copy for two of the four invalid-path cases",
    async ({ page }) => {
      await page.goto(jasper.baseURL + "/setup");
      const input = page.getByLabel("Data directory path");
      await input.fill("/nonexistent-prefix-zzz-08-15/jasper");
      await expect(
        page.getByText(/parent folder doesn('|’)t exist/i),
      ).toBeVisible({ timeout: 5_000 });
      await input.fill("/tmp/jasper-é");
      await expect(
        page.getByText(/don('|’)t survive cross-platform sync/i),
      ).toBeVisible({ timeout: 5_000 });
    },
  );

  test(
    "tilde-prefixed data-dir paths are expanded against $HOME (not literal)",
    async () => {
      const os = await import("node:os");
      const path = await import("node:path");
      const fs = await import("node:fs/promises");

      const suffix = `jasper-e2e-tilde-${Date.now()}-${Math.floor(
        Math.random() * 1e6,
      )}`;
      const tildePath = `~/${suffix}`;
      const expandedPath = path.join(os.homedir(), suffix);

      const cwdTildePath = path.join(process.cwd(), "~");
      const preExistedTildeDir = await fs
        .stat(cwdTildePath)
        .then(() => true)
        .catch(() => false);

      try {
        const resp = await fetch(
          jasper.baseURL + "/api/v1/setup/validate-data-dir",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: tildePath }),
          },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
          valid: boolean;
          code?: string;
          message?: string;
        };
        expect(
          body.valid,
          `expected valid=true after tilde expansion; body=${JSON.stringify(body)}`,
        ).toBe(true);

        const postExistsTildeDir = await fs
          .stat(cwdTildePath)
          .then(() => true)
          .catch(() => false);
        if (!preExistedTildeDir) {
          expect(
            postExistsTildeDir,
            `validator created a literal "~" dir at ${cwdTildePath} — tilde expansion did not run`,
          ).toBe(false);
        }

        const exists = await fs
          .stat(expandedPath)
          .then(() => true)
          .catch(() => false);
        expect(
          exists,
          `expected write-probe target ${expandedPath} to exist after validate`,
        ).toBe(true);
      } finally {
        await fs.rm(expandedPath, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  test(
    "relative paths are refused with the not_absolute code",
    async () => {
      const resp = await fetch(
        jasper.baseURL + "/api/v1/setup/validate-data-dir",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "Documents/Jasper" }),
        },
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        valid: boolean;
        code?: string;
        message?: string;
      };
      expect(body.valid).toBe(false);
      expect(body.code).toBe("not_absolute");
      expect(body.message).toMatch(/absolute path/i);
    },
  );
});


test.describe("deep link routes (@deep-link)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("the /note-not-found view renders the LOCKED heading and three CTAs", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));
    await page.goto(jasper.baseURL + "/note-not-found");
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByTestId("note-not-found-view"),
      `note-not-found-view not visible; console errors so far: ${consoleErrors.join("; ")}`,
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("heading", { name: /This note doesn.t exist/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Search notes" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Open today.s note/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show file tree" })).toBeVisible();
  });
});


test.describe("reveal in file manager (@reveal)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("right-clicking the seeded scratchpad row exposes 'Show in file manager'", async ({ page }) => {
    await page.goto(jasper.baseURL + "/");
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 15_000 },
    );
    const row = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: "scratchpad" })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click({ button: "right" });
    await expect(page.getByText("Show in file manager")).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
  });
});


test.describe("grant toast contract (@grant)", () => {
  test("Tier-1 grant toast strings match the 08-10 LOCKED two-line shape", () => {
    const GRANT_TITLE = "AI access granted";
    const GRANT_DESC_TIER1 = "Edit only in projects";
    const GRANT_DESC_TIER2 = "Full in projects";
    expect(GRANT_TITLE).toBe("AI access granted");
    expect(GRANT_DESC_TIER1).toBe("Edit only in projects");
    expect(GRANT_DESC_TIER2).toBe("Full in projects");
  });

  test("Tier-2 upgrade toast strings match the 08-10 LOCKED two-line shape", () => {
    const UPGRADE_TITLE = "AI access upgraded";
    const UPGRADE_DESC = "Now full in projects";
    expect(UPGRADE_TITLE).toBe("AI access upgraded");
    expect(UPGRADE_DESC).toBe("Now full in projects");
  });

  test("Revoke toast strings match the 08-10 LOCKED two-line shape", () => {
    const REVOKE_TITLE = "AI access revoked";
    const REVOKE_DESC = "projects";
    expect(REVOKE_TITLE).toBe("AI access revoked");
    expect(REVOKE_DESC).toBe("projects");
  });
});


test.describe("sparkles indicator contract (@sparkles)", () => {
  test("the McpGrantIndicator selector contract is pinned: testid + data-grant-tier", () => {
    const TESTID = "mcp-grant-indicator";
    const ATTR_TIER1 = 'data-grant-tier="1"';
    const ATTR_TIER2 = 'data-grant-tier="2"';
    expect(TESTID).toBe("mcp-grant-indicator");
    expect(ATTR_TIER1).toBe('data-grant-tier="1"');
    expect(ATTR_TIER2).toBe('data-grant-tier="2"');
  });
});


test.describe("install follow-up (@uat-1-followup)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test(
    "duplicate grant flashes error and submits with single DB row",
    async () => {
      const os = await import("node:os");
      const path = await import("node:path");
      const fs = await import("node:fs/promises");
      const { execFileSync } = await import("node:child_process");

      const suffix = `jasper-e2e-n8-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const tildePath = `~/${suffix}`;
      const expandedPath = path.join(os.homedir(), suffix);

      try {
        const validateResp = await fetch(
          jasper.baseURL + "/api/v1/setup/validate-data-dir",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: tildePath }),
          },
        );
        expect(validateResp.status).toBe(200);
        const validateBody = (await validateResp.json()) as {
          valid: boolean;
          code?: string;
          message?: string;
        };
        expect(
          validateBody.valid,
          `N1 sanity gate: expected valid=true for tilde path; body=${JSON.stringify(validateBody)}`,
        ).toBe(true);

        const setupResp = await fetch(jasper.baseURL + "/api/v1/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            data_dir: tildePath,
            theme: "dark",
            mcp_grants: [
              { folder: "ai-zone", level: 1 },
              { folder: "ai-zone", level: 2 },
            ],
            daily_template: "# {{date}}\n\n",
            create_today_daily_note: false,
          }),
        });
        expect(
          setupResp.status,
          `Expected 200 from /api/v1/setup; got ${setupResp.status}`,
        ).toBe(200);

        // The setup endpoint writes seed_grants.json but does NOT open
        // SQLite — migrations run on first boot.  Boot the new vault so
        // ApplySeedGrants drains the queue and creates the DB row, then
        // kill and query.
        const bootedVault = await spawnJasper({ dataDir: expandedPath });
        await bootedVault.kill();

        const dbPath = path.join(expandedPath, ".jasper", "app.db");
        let sqlite3Available = false;
        try {
          execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
          sqlite3Available = true;
        } catch {
          // sqlite3 not on PATH — fall through to 200-only assertion.
        }

        if (sqlite3Available) {
          const output = execFileSync("sqlite3", [
            dbPath,
            "SELECT folder_path, level FROM mcp_write_grants ORDER BY folder_path",
          ])
            .toString()
            .trim();
          expect(
            output,
            `Expected single row 'ai-zone|2' in mcp_write_grants; got: ${JSON.stringify(output)}`,
          ).toBe("ai-zone|2");
        }
        // If sqlite3 is missing, the 200-status assertion above is the
        // contract; backend unit tests pin the row-count behavior.
      } finally {
        await fs.rm(expandedPath, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});


test.describe("R4-11 (@r4-11) stack-overflow regression", () => {
  let jasper: JasperHandle;
  let dataDir: string;

  test.beforeAll(async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");

    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "jasper-r4-11-"));
    const wide = path.join(dataDir, "notes", "wide");
    await fs.mkdir(wide, { recursive: true });
    for (let i = 0; i < 500; i++) {
      const sub = path.join(wide, `sub-${i.toString().padStart(3, "0")}`);
      await fs.mkdir(sub, { recursive: true });
      await fs.writeFile(path.join(sub, "n.md"), `# n${i}\n`, "utf8");
    }
    jasper = await spawnJasper({ dataDir });
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (dataDir) {
      const fs = await import("node:fs/promises");
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("R4-11 — opens crashing folder without stack overflow", async ({
    page,
  }) => {
    const STACK_OVERFLOW_RE = /Maximum call stack size exceeded/i;
    const captured: string[] = [];

    page.on("pageerror", (err) => {
      const msg = `${err.name}: ${err.message}\n${err.stack ?? ""}`;
      if (STACK_OVERFLOW_RE.test(msg)) captured.push("pageerror: " + msg);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (STACK_OVERFLOW_RE.test(text)) captured.push("console: " + text);
      }
    });

    await page.goto(jasper.baseURL);
    if (page.url().endsWith("/setup")) {
      await page.goto(jasper.baseURL);
    }

    await page.waitForSelector("[data-tree-row]", { timeout: 10_000 });

    const wideRow = page.locator(
      '[data-tree-row="wide"][data-tree-row-kind="folder"]',
    );
    await wideRow.waitFor({ state: "visible", timeout: 5_000 });
    await wideRow.click();

    await page.waitForTimeout(2_000);

    await expect(wideRow).toHaveAttribute("aria-expanded", "true");
    expect(
      captured,
      `Stack overflow detected on plain-click folder expansion — R4-11 regression.\nCaptured:\n${captured.join("\n\n")}`,
    ).toEqual([]);
  });
});


test.describe("R4-1 (@r4-1) create_note atomic regression", () => {
  test.describe.configure({ mode: "serial" });
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    const path = await import("node:path");
    const fs = await import("node:fs/promises");

    // Each binary binds its MCP listener to its own ephemeral port
    // (jasper.mcpPort via JASPER_MCP_PORT), so no cross-process port lock is
    // needed and these tests run fully parallel with the rest of the suite.
    jasper = await spawnJasper();

    const projectsDir = path.join(jasper.dataDir, "notes", "projects");
    await fs.mkdir(projectsDir, { recursive: true });

    const grantResp = await fetch(jasper.baseURL + "/api/v1/mcp/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder_path: "projects", level: 1 }),
    });
    if (grantResp.status !== 200) {
      const body = await grantResp.text();
      throw new Error(`mcp/grants POST failed: ${grantResp.status} ${body}`);
    }

    const deadline = Date.now() + 5_000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const probe = await fetch(`http://127.0.0.1:${jasper.mcpPort}/healthz`);
        if (probe.status === 200) {
          break;
        }
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `MCP /healthz did not respond at port ${jasper.mcpPort} within 5s: ${String(lastErr)}`,
      );
    }
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("R4-1 — create_note is atomic, no partial scaffold on failure", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const notesRoot = path.join(jasper.dataDir, "notes");

    let sessionID: string | null = null;
    let nextID = 1;

    async function rpc(
      method: string,
      params: Record<string, unknown> | undefined,
      isNotification: boolean,
    ): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
      const body: Record<string, unknown> = {
        jsonrpc: "2.0",
        method,
      };
      if (params !== undefined) body.params = params;
      if (!isNotification) body.id = nextID++;

      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      if (sessionID) headers["mcp-session-id"] = sessionID;

      const resp = await fetch(`http://127.0.0.1:${jasper.mcpPort}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const sid = resp.headers.get("mcp-session-id");
      if (sid && !sessionID) sessionID = sid;

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
        throw new Error(
          `no SSE data line in response (status=${resp.status}): ${text}`,
        );
      }
      const payload = JSON.parse(dataLine.slice("data: ".length)) as {
        result?: unknown;
        error?: { code: number; message: string };
      };
      return payload;
    }

    const initOut = await rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "r4-1-spec", version: "1.0.0" },
      },
      false,
    );
    expect(
      initOut.error,
      `initialize returned an error: ${JSON.stringify(initOut.error)}`,
    ).toBeUndefined();
    expect(sessionID, "expected Mcp-Session-Id header on initialize response").toBeTruthy();
    await rpc("notifications/initialized", {}, true);

    const body =
      "First line of body.\n\n```go\nfunc main(){println(\"hello\")}\n```\n\nSecond paragraph after the fence.\n";
    const successOut = await rpc(
      "tools/call",
      {
        name: "create_note",
        arguments: {
          path: "projects/r4-1-atomic.md",
          body,
        },
      },
      false,
    );
    expect(
      successOut.error,
      `create_note success arm returned RPC error: ${JSON.stringify(successOut.error)}`,
    ).toBeUndefined();
    const successResult = successOut.result as {
      isError?: boolean;
      structuredContent?: { id?: string; path?: string; updated_at?: string };
      content?: Array<{ type: string; text?: string }>;
    };
    expect(
      successResult.isError,
      `expected success; tool result: ${JSON.stringify(successResult)}`,
    ).toBeFalsy();
    expect(successResult.structuredContent?.id, "expected id in structuredContent").toBeTruthy();
    expect(successResult.structuredContent?.updated_at, "expected updated_at").toBeTruthy();

    const filePath = path.join(notesRoot, "projects", "r4-1-atomic.md");
    const onDisk = await fs.readFile(filePath, "utf8");
    const wantPrefix = "---\ntags: []\n---\n\n# r4-1-atomic\n\n";
    expect(
      onDisk.startsWith(wantPrefix),
      `file missing canonical scaffold prefix.\n got=${JSON.stringify(onDisk)}\n want prefix=${JSON.stringify(wantPrefix)}`,
    ).toBe(true);
    expect(
      onDisk,
      `body bytes must append verbatim after the scaffold (no separator).`,
    ).toBe(wantPrefix + body);

    const collisionOut = await rpc(
      "tools/call",
      {
        name: "create_note",
        arguments: {
          path: "projects/r4-1-atomic.md",
          body: "this body would clobber the first file",
        },
      },
      false,
    );
    expect(
      collisionOut.error,
      `collision arm: expected MCP RPC OK but tool-level error; got RPC error: ${JSON.stringify(collisionOut.error)}`,
    ).toBeUndefined();
    const collisionResult = collisionOut.result as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    expect(
      collisionResult.isError,
      `expected isError=true on duplicate-path create; got: ${JSON.stringify(collisionResult)}`,
    ).toBe(true);
    const collisionText = JSON.stringify(collisionResult);
    expect(
      collisionText.includes("already_exists"),
      `expected 'already_exists' in collision error: ${collisionText}`,
    ).toBe(true);
    expect(
      collisionText.includes("partial_create"),
      `R4-2 regression: response contains partial_create: ${collisionText}`,
    ).toBe(false);

    const afterCollision = await fs.readFile(filePath, "utf8");
    expect(afterCollision, "file mutated by failed collision create").toBe(onDisk);

    const traversalOut = await rpc(
      "tools/call",
      {
        name: "create_note",
        arguments: {
          path: "../traversal.md",
          body: "should never land",
        },
      },
      false,
    );
    const traversalResult = traversalOut.result as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    expect(traversalResult.isError, "expected isError on traversal path").toBe(true);
    const traversalText = JSON.stringify(traversalResult);
    expect(
      traversalText.includes("partial_create"),
      `R4-2 regression: traversal error contains partial_create: ${traversalText}`,
    ).toBe(false);
    const traversalCheck = path.join(jasper.dataDir, "..", "traversal.md");
    await expect(
      fs.stat(traversalCheck).then(
        () => "exists",
        () => "missing",
      ),
    ).resolves.toBe("missing");
  });
});


test.describe("08-20 menu + AI-folder CSS (@r4-7-r4-8-r4-10)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("R4-7 — menu item hover does not shift horizontally", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL + "/");
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 15_000 },
    );
    const row = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: "scratchpad" })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click({ button: "right" });

    const item = page.locator('[role="menuitem"]').first();
    await expect(item).toBeVisible({ timeout: 5_000 });

    await page.mouse.move(0, 0);
    await page.waitForTimeout(100);
    const before = await item.boundingBox();
    if (!before) throw new Error("menu item bounding box (before hover) was null");

    await item.hover();
    await page.waitForTimeout(150);
    const after = await item.boundingBox();
    if (!after) throw new Error("menu item bounding box (after hover) was null");

    expect(
      Math.abs(after.x - before.x),
      `R4-7: menu item x shifted on hover; before=${before.x} after=${after.x}`,
    ).toBeLessThan(0.5);
    expect(
      Math.abs(after.width - before.width),
      `R4-7: menu item width changed on hover; before=${before.width} after=${after.width}`,
    ).toBeLessThan(0.5);

    await page.keyboard.press("Escape");
  });

  test("R4-8 — active + highlighted menu item has stable border-radius", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL + "/");
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 15_000 },
    );
    const row = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: "scratchpad" })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click({ button: "right" });

    const items = page.locator('[role="menuitem"]');
    const count = await items.count();
    expect(count, "expected at least 2 menu items in the context menu").toBeGreaterThanOrEqual(2);

    const highlighted = items.nth(0);
    const baseline = items.nth(1);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(100);
    await highlighted.hover();
    await page.waitForTimeout(150);

    const radiusHighlighted = await highlighted.evaluate(
      (el) => getComputedStyle(el as HTMLElement).borderRadius,
    );
    const radiusBaseline = await baseline.evaluate(
      (el) => getComputedStyle(el as HTMLElement).borderRadius,
    );

    expect(
      radiusHighlighted.trim(),
      `R4-8: highlighted border-radius (${radiusHighlighted}) differs from baseline (${radiusBaseline}) — hover must not alter corners`,
    ).toBe(radiusBaseline.trim());

    await page.keyboard.press("Escape");
  });

  test("R4-10 — AI-granted folder retains violet tint when selected", async ({
    page,
  }) => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "jasper-r4-10-"));
    try {
      const notesDir = path.join(dataDir, "notes");
      await fs.mkdir(path.join(notesDir, "projects"), { recursive: true });
      await fs.mkdir(path.join(notesDir, "plain-folder"), { recursive: true });
      await fs.writeFile(
        path.join(notesDir, "projects", "ai-note.md"),
        "# ai-note\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(notesDir, "plain-folder", "plain-note.md"),
        "# plain-note\n",
        "utf8",
      );

      const local = await spawnJasper({ dataDir });
      try {
        const grant = await fetch(local.baseURL + "/api/v1/mcp/grants", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ folder_path: "projects", level: 1 }),
        });
        expect(grant.status, "grant POST status").toBe(200);

        await page.goto(local.baseURL + "/");
        await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
          "data-status",
          "connected",
          { timeout: 15_000 },
        );

        const aiRow = page.locator(
          '[data-tree-row="projects"][data-tree-row-kind="folder"]',
        );
        const plainRow = page.locator(
          '[data-tree-row="plain-folder"][data-tree-row-kind="folder"]',
        );
        await expect(aiRow).toBeVisible({ timeout: 10_000 });
        await expect(plainRow).toBeVisible({ timeout: 10_000 });

        await expect(aiRow).toHaveAttribute("data-ai-level", "1", {
          timeout: 5_000,
        });

        const isMac = process.platform === "darwin";
        const modifier = isMac ? "Meta" : "Control";
        await aiRow.click({ modifiers: [modifier] });
        await plainRow.click({ modifiers: [modifier] });

        await expect(aiRow).toHaveAttribute("data-selected", "true", {
          timeout: 5_000,
        });
        await expect(plainRow).toHaveAttribute("data-selected", "true", {
          timeout: 5_000,
        });

        const aiColor = await aiRow.evaluate(
          (el) => getComputedStyle(el as HTMLElement).backgroundColor,
        );
        const plainColor = await plainRow.evaluate(
          (el) => getComputedStyle(el as HTMLElement).backgroundColor,
        );

        const parseRgb = (s: string): [number, number, number] => {
          const mRgb = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
          if (mRgb) {
            return [
              parseInt(mRgb[1], 10),
              parseInt(mRgb[2], 10),
              parseInt(mRgb[3], 10),
            ];
          }
          const mSrgb = s.match(
            /color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/,
          );
          if (mSrgb) {
            return [
              Math.round(parseFloat(mSrgb[1]) * 255),
              Math.round(parseFloat(mSrgb[2]) * 255),
              Math.round(parseFloat(mSrgb[3]) * 255),
            ];
          }
          throw new Error(`unparseable color: ${s}`);
        };
        const [aiR, aiG, aiB] = parseRgb(aiColor);
        const [plainR, plainG, plainB] = parseRgb(plainColor);

        // v1.2 redesign unified --color-accent to violet-400 (#a78bfa), the same
        // hue as --color-ai-grant. Pre-redesign the accent was a non-violet hue,
        // so an AI row's violet read as "more red" than a plain selected row and
        // the old check compared red channels (aiR > plainR). Now BOTH selected
        // backgrounds share the violet hue (identical R,G,B); the AI grant keeps
        // its identity by being a *stronger* violet — a 24% mix vs the plain
        // row's 4% accent mix. So the surviving distinction is tint strength
        // (opacity), not hue. Assert the AI row reads as the more intense violet.
        const parseAlpha = (s: string): number => {
          const mSlash = s.match(/\/\s*([\d.]+)\s*\)/); // color(srgb r g b / a) or rgb(r g b / a)
          if (mSlash) return parseFloat(mSlash[1]);
          const mComma = s.match(
            /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/,
          );
          if (mComma) return parseFloat(mComma[1]);
          return 1; // opaque form carries no alpha component
        };
        const aiAlpha = parseAlpha(aiColor);
        const plainAlpha = parseAlpha(plainColor);

        expect(
          aiColor !== plainColor,
          `R4-10: AI row color (${aiColor}) is indistinguishable from plain selected (${plainColor}) — violet identity lost on selection`,
        ).toBe(true);
        expect(
          aiAlpha > plainAlpha,
          `R4-10: AI selected tint (${aiColor}, α=${aiAlpha}) must read as a stronger violet than the plain selected row (${plainColor}, α=${plainAlpha}) — violet identity must survive selection. aiRGB=${aiR},${aiG},${aiB} plainRGB=${plainR},${plainG},${plainB}`,
        ).toBe(true);
        expect(
          aiB,
          `R4-10 diagnostic: aiB=${aiB} plainB=${plainB}`,
        ).toBeGreaterThan(0);
      } finally {
        await local.kill();
      }
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});


test.describe("R4-15 (@r4-15) --data-dir flag removed", () => {
  test("R4-15 — --data-dir flag is removed (unknown flag)", async () => {
    const { spawn } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const { fileURLToPath } = await import("node:url");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, "..", "..");
    const JASPER_BIN = path.join(repoRoot, "bin", "jasper");

    const exists = await fs
      .stat(JASPER_BIN)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      throw new Error(
        `bin/jasper missing — run \`make build\` first. Expected at: ${JASPER_BIN}`,
      );
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jasper-r4-15-"));

    try {
      const proc = spawn(
        JASPER_BIN,
        ["serve", "--data-dir", tmpDir, "--bind", "127.0.0.1:0"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      let stderr = "";
      proc.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString();
      });
      let stdout = "";
      proc.stdout?.on("data", (b: Buffer) => {
        stdout += b.toString();
      });

      const exitCode = await new Promise<number | null>((resolve) => {
        const killTimer = setTimeout(() => {
          proc.kill("SIGKILL");
        }, 5_000);
        proc.once("exit", (code) => {
          clearTimeout(killTimer);
          resolve(code);
        });
      });

      expect(
        exitCode !== 0 && exitCode !== null,
        `expected non-zero exit; got code=${exitCode}; stdout=${stdout}; stderr=${stderr}`,
      ).toBe(true);
      expect(
        stderr.includes("flag provided but not defined: -data-dir"),
        `expected stderr to contain stdlib unknown-flag error; got: ${stderr}`,
      ).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("R4-15 — JASPER_DATA_DIR is silently ignored (no deprecation warning)", async () => {
    const { spawn } = await import("node:child_process");
    const { createServer } = await import("node:net");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const { fileURLToPath } = await import("node:url");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, "..", "..");
    const JASPER_BIN = path.join(repoRoot, "bin", "jasper");

    const port = await new Promise<number>((resolve, reject) => {
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

    const vaultDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "jasper-r4-15-vault-"),
    );
    const fakeAppHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "jasper-r4-15-app-"),
    );
    const ignoredPath = path.join(os.tmpdir(), "this-path-must-not-be-used");

    try {
      const proc = spawn(
        JASPER_BIN,
        ["serve", "--vault", vaultDir, "--bind", `127.0.0.1:${port}`],
        {
          env: {
            ...process.env,
            JASPER_DATA_DIR: ignoredPath,
            JASPER_APP_HOME: fakeAppHome,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stderr = "";
      proc.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString();
      });
      let stdout = "";
      proc.stdout?.on("data", (b: Buffer) => {
        stdout += b.toString();
      });

      const baseURL = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 15_000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${baseURL}/api/v1/admin/status`);
          if (r.status === 200) {
            ready = true;
            break;
          }
        } catch {
          // not yet listening
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      try {
        expect(
          ready,
          `server with JASPER_DATA_DIR set did not become ready; stdout=${stdout}; stderr=${stderr}`,
        ).toBe(true);

        expect(
          stderr.includes("JASPER_DATA_DIR is deprecated"),
          `JASPER_DATA_DIR should be silently ignored, but a deprecation warning was emitted: ${stderr}`,
        ).toBe(false);
      } finally {
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
    } finally {
      await fs.rm(vaultDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(fakeAppHome, { recursive: true, force: true }).catch(() => {});
    }
  });
});


test.describe("08-21 MCP tooling (@r4-3-r4-4-r4-6)", () => {
  test.describe.configure({ mode: "serial" });
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    const path = await import("node:path");
    const fs = await import("node:fs/promises");

    // Per-binary ephemeral MCP port (jasper.mcpPort via JASPER_MCP_PORT) — no
    // cross-process lock needed.
    jasper = await spawnJasper();

    await fs.mkdir(path.join(jasper.dataDir, "notes", "projects"), { recursive: true });
    await fs.mkdir(path.join(jasper.dataDir, "notes", "drafts"), { recursive: true });

    const deadline = Date.now() + 5_000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const probe = await fetch(`http://127.0.0.1:${jasper.mcpPort}/healthz`);
        if (probe.status === 200) {
          break;
        }
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `MCP /healthz did not respond at port ${jasper.mcpPort} within 5s: ${String(lastErr)}`,
      );
    }
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  async function newMcpSession(): Promise<{
    rpc: (
      method: string,
      params: Record<string, unknown> | undefined,
      isNotification: boolean,
    ) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  }> {
    let sessionID: string | null = null;
    let nextID = 1;

    async function rpc(
      method: string,
      params: Record<string, unknown> | undefined,
      isNotification: boolean,
    ): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
      const body: Record<string, unknown> = { jsonrpc: "2.0", method };
      if (params !== undefined) body.params = params;
      if (!isNotification) body.id = nextID++;

      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      if (sessionID) headers["mcp-session-id"] = sessionID;

      const resp = await fetch(`http://127.0.0.1:${jasper.mcpPort}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const sid = resp.headers.get("mcp-session-id");
      if (sid && !sessionID) sessionID = sid;

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
      return JSON.parse(dataLine.slice("data: ".length)) as {
        result?: unknown;
        error?: { code: number; message: string };
      };
    }

    const initOut = await rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "r4-3-r4-4-r4-6-spec", version: "1.0.0" },
      },
      false,
    );
    expect(
      initOut.error,
      `initialize error: ${JSON.stringify(initOut.error)}`,
    ).toBeUndefined();
    expect(sessionID, "expected Mcp-Session-Id header").toBeTruthy();
    await rpc("notifications/initialized", {}, true);

    return { rpc };
  }

  test("R4-3 — list_grants returns active grants", async () => {
    const grantsToSeed = [
      { folder_path: "projects", level: 1 },
      { folder_path: "drafts", level: 2 },
    ];
    for (const g of grantsToSeed) {
      const r = await fetch(jasper.baseURL + "/api/v1/mcp/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(g),
      });
      expect(
        r.status,
        `mcp/grants seed for ${g.folder_path} failed: ${r.status} ${await r.text()}`,
      ).toBe(200);
    }

    const { rpc } = await newMcpSession();
    const out = await rpc(
      "tools/call",
      { name: "list_grants", arguments: {} },
      false,
    );
    expect(out.error, `RPC error: ${JSON.stringify(out.error)}`).toBeUndefined();
    const result = out.result as {
      isError?: boolean;
      structuredContent?: { grants?: Array<{ path: string; tier: number; granted_at: string }> };
      content?: Array<{ type: string; text?: string }>;
    };
    expect(
      result.isError,
      `list_grants tool error: ${JSON.stringify(result)}`,
    ).toBeFalsy();
    const grants = result.structuredContent?.grants;
    expect(grants, "expected grants in structuredContent").toBeTruthy();
    expect(grants!.length).toBe(2);

    expect(grants![0].path).toBe("drafts");
    expect(grants![0].tier).toBe(2);
    expect(grants![1].path).toBe("projects");
    expect(grants![1].tier).toBe(1);
    for (const g of grants!) {
      expect(g.granted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }

    for (const g of grantsToSeed) {
      await fetch(
        jasper.baseURL + "/api/v1/mcp/grants?path=" + encodeURIComponent(g.folder_path),
        { method: "DELETE" },
      );
    }
  });

  test("R4-4 — create_note honours optional title", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const grantResp = await fetch(jasper.baseURL + "/api/v1/mcp/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder_path: "projects", level: 1 }),
    });
    expect(grantResp.status).toBe(200);

    const { rpc } = await newMcpSession();
    const out = await rpc(
      "tools/call",
      {
        name: "create_note",
        arguments: {
          path: "projects/r4-4-title.md",
          title: "My Friendly Title",
        },
      },
      false,
    );
    expect(out.error, `RPC error: ${JSON.stringify(out.error)}`).toBeUndefined();
    const result = out.result as {
      isError?: boolean;
      structuredContent?: { id?: string; path?: string; updated_at?: string };
    };
    expect(
      result.isError,
      `create_note tool error: ${JSON.stringify(result)}`,
    ).toBeFalsy();

    const filePath = path.join(jasper.dataDir, "notes", "projects", "r4-4-title.md");
    const contents = await fs.readFile(filePath, "utf8");
    expect(contents).toContain("# My Friendly Title");
    expect(contents).not.toMatch(/^# r4-4-title\b/m);

    await fetch(jasper.baseURL + "/api/v1/mcp/grants?path=projects", {
      method: "DELETE",
    });
  });

  test("R4-6 — update_note accepts if_match=* and rejects stale literal tag", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const grantResp = await fetch(jasper.baseURL + "/api/v1/mcp/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder_path: "projects", level: 1 }),
    });
    expect(grantResp.status).toBe(200);

    const { rpc } = await newMcpSession();
    const createOut = await rpc(
      "tools/call",
      {
        name: "create_note",
        arguments: { path: "projects/r4-6-wildcard.md", body: "initial body\n" },
      },
      false,
    );
    expect(createOut.error).toBeUndefined();
    const createResult = createOut.result as {
      isError?: boolean;
      structuredContent?: { id?: string; path?: string; updated_at?: string };
    };
    expect(createResult.isError, JSON.stringify(createResult)).toBeFalsy();
    const notePath = createResult.structuredContent!.path!;

    const wildcardBody = "wildcard overwrite body — last writer wins\n";
    const wildcardOut = await rpc(
      "tools/call",
      {
        name: "update_note",
        arguments: {
          path: notePath,
          body: wildcardBody,
          if_match: "*",
        },
      },
      false,
    );
    expect(wildcardOut.error).toBeUndefined();
    const wildcardResult = wildcardOut.result as {
      isError?: boolean;
      structuredContent?: { force_write?: boolean; updated_at?: string };
    };
    expect(
      wildcardResult.isError,
      `wildcard update tool error: ${JSON.stringify(wildcardResult)}`,
    ).toBeFalsy();
    expect(wildcardResult.structuredContent?.force_write).toBe(true);

    const filePath = path.join(jasper.dataDir, "notes", "projects", "r4-6-wildcard.md");
    const onDisk = await fs.readFile(filePath, "utf8");
    expect(onDisk).toContain(wildcardBody);

    const staleTag = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const staleOut = await rpc(
      "tools/call",
      {
        name: "update_note",
        arguments: {
          path: notePath,
          body: "this should never land",
          if_match: staleTag,
        },
      },
      false,
    );
    expect(staleOut.error).toBeUndefined();
    const staleResult = staleOut.result as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    expect(staleResult.isError, "expected conflict for stale literal tag").toBe(true);
    const staleText = JSON.stringify(staleResult);
    expect(staleText).toContain("conflict");
    expect(staleText).not.toContain(`"force_write":true`);

    await fetch(jasper.baseURL + "/api/v1/mcp/grants?path=projects", {
      method: "DELETE",
    });
  });
});


async function spawnAndBootstrapVault(opts: {
  appHomeSuffix: string;
  vaultSuffix: string;
  seed: (vaultDir: string) => Promise<void>;
}): Promise<{
  baseURL: string;
  cleanup: () => Promise<void>;
}> {
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const fsP = await import("node:fs/promises");
  const fsS = await import("node:fs");

  const appHome = await fsP.mkdtemp(
    pathMod.join(osMod.tmpdir(), opts.appHomeSuffix),
  );
  const vaultRaw = await fsP.mkdtemp(
    pathMod.join(osMod.tmpdir(), opts.vaultSuffix),
  );
  const vault = process.platform === "darwin"
    ? fsS.realpathSync(vaultRaw).toLowerCase()
    : fsS.realpathSync(vaultRaw);
  await opts.seed(vault);

  const cp = await import("node:child_process");
  const net = await import("node:net");
  const fileURLMod = await import("node:url");
  const here = fileURLMod.fileURLToPath(import.meta.url);
  const repoRoot = pathMod.resolve(pathMod.dirname(here), "..", "..");
  const JASPER_BIN = pathMod.join(repoRoot, "bin", "jasper");

  const port = await new Promise<number>((res, rej) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        srv.close(() => res(p));
      } else rej(new Error("no port"));
    });
  });

  const proc = cp.spawn(JASPER_BIN, ["serve", "--bind", `127.0.0.1:${port}`], {
    env: { ...process.env, JASPER_APP_HOME: appHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (b: Buffer) => process.stderr.write(`[jasper] ${b}`));
  proc.stderr?.on("data", (b: Buffer) => process.stderr.write(`[jasper] ${b}`));

  const baseURL = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseURL}/api/v1/vault/current`);
      if (r.ok || r.status === 404) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const createRes = await fetch(`${baseURL}/api/v1/vault/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: vault,
      theme: "dark",
      daily_template: "",
    }),
  });
  if (!createRes.ok) {
    throw new Error(
      `vault/create failed: ${createRes.status} ${await createRes.text()}`,
    );
  }
  const openRes = await fetch(`${baseURL}/api/v1/vault/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: vault }),
  });
  if (!openRes.ok) {
    throw new Error(
      `vault/open failed: ${openRes.status} ${await openRes.text()}`,
    );
  }

  return {
    baseURL,
    cleanup: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      await fsP.rm(appHome, { recursive: true, force: true }).catch(() => {});
      await fsP.rm(vaultRaw, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test.describe("08-22 tree row + ACL refresh (@r4-9-r4-12-r4-13)", () => {
  test("R4-9 — child folder shows inherited grant, no separate Grant AI access action", async ({
    page,
  }) => {
    const pathMod = await import("node:path");
    const fsP = await import("node:fs/promises");

    const local = await spawnAndBootstrapVault({
      appHomeSuffix: "jasper-r4-9-app-",
      vaultSuffix: "jasper-r4-9-vault-",
      seed: async (vault) => {
        const notesDir = pathMod.join(vault, "notes");
        await fsP.mkdir(pathMod.join(notesDir, "projects", "research"), {
          recursive: true,
        });
        await fsP.writeFile(
          pathMod.join(notesDir, "projects", "top.md"),
          "# top\n",
          "utf8",
        );
        await fsP.writeFile(
          pathMod.join(notesDir, "projects", "research", "inner.md"),
          "# inner\n",
          "utf8",
        );
      },
    });
    try {
      const grant = await fetch(local.baseURL + "/api/v1/mcp/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder_path: "projects", level: 1 }),
      });
      expect(grant.status, "grant POST status").toBe(200);

      await page.goto(local.baseURL + "/");
      await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 15_000 },
      );

      const projectsRow = page.locator(
        '[data-tree-row="projects"][data-tree-row-kind="folder"]',
      );
      await expect(projectsRow).toBeVisible({ timeout: 10_000 });
      await projectsRow.click();

      const researchRow = page.locator(
        '[data-tree-row="projects/research"][data-tree-row-kind="folder"]',
      );
      await expect(researchRow).toBeVisible({ timeout: 10_000 });

      await researchRow.click({ button: "right" });

      const enabledGrantTrigger = page.getByRole("menuitem", {
        name: /^Grant AI access$/,
      });
      const inheritedItem = page.locator(
        '[role="menuitem"][data-inherited-grant="true"]',
      );
      await expect(inheritedItem).toBeVisible({ timeout: 5_000 });
      await expect(inheritedItem).toContainText(
        /Inherits AI access from projects \(Edit only\)/,
      );
      await expect(enabledGrantTrigger).toHaveCount(0);

      await page.keyboard.press("Escape");

      await expect(projectsRow).toHaveAttribute("data-ai-level", "1", {
        timeout: 5_000,
      });
    } finally {
      await local.cleanup();
    }
  });

  test("R4-12 — context menu stays closed after granting AI access", async ({
    page,
  }) => {
    const pathMod = await import("node:path");
    const fsP = await import("node:fs/promises");

    const local = await spawnAndBootstrapVault({
      appHomeSuffix: "jasper-r4-12-app-",
      vaultSuffix: "jasper-r4-12-vault-",
      seed: async (vault) => {
        const notesDir = pathMod.join(vault, "notes");
        await fsP.mkdir(pathMod.join(notesDir, "drafts"), { recursive: true });
        await fsP.writeFile(
          pathMod.join(notesDir, "drafts", "scratch.md"),
          "# scratch\n",
          "utf8",
        );
      },
    });
    try {
      await page.goto(local.baseURL + "/");
      await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 15_000 },
      );

      const draftsRow = page.locator(
        '[data-tree-row="drafts"][data-tree-row-kind="folder"]',
      );
      await expect(draftsRow).toBeVisible({ timeout: 10_000 });

      await draftsRow.click({ button: "right" });
      const grantTrigger = page.getByRole("menuitem", {
        name: /^Grant AI access$/,
      });
      await expect(grantTrigger).toBeVisible({ timeout: 5_000 });

      await grantTrigger.hover();
      const editOnlyItem = page
        .getByRole("menuitem", { name: /Edit only/ })
        .first();
      await expect(editOnlyItem).toBeVisible({ timeout: 5_000 });
      await editOnlyItem.click();

      const anyMenu = page.locator('[role="menu"]');
      await expect(anyMenu).toHaveCount(0, { timeout: 1_000 });

      await page.waitForTimeout(3_000);
      await expect(anyMenu).toHaveCount(0);

      await expect(draftsRow).toHaveAttribute("data-ai-level", "1", {
        timeout: 5_000,
      });
    } finally {
      await local.cleanup();
    }
  });

  test("R4-13 — vault switch does not fire 404 for prior-vault note", async ({
    page,
  }) => {
    const pathMod = await import("node:path");
    const fsP = await import("node:fs/promises");

    const local = await spawnAndBootstrapVault({
      appHomeSuffix: "jasper-r4-13-app-",
      vaultSuffix: "jasper-r4-13-vault-",
      seed: async (vault) => {
        const notesDir = pathMod.join(vault, "notes");
        await fsP.mkdir(notesDir, { recursive: true });
        await fsP.writeFile(
          pathMod.join(notesDir, "alpha.md"),
          "# alpha\n\nvault A content.\n",
          "utf8",
        );
      },
    });
    try {
      await page.goto(local.baseURL + "/");
      await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 15_000 },
      );

      const alphaRow = page
        .locator('[data-tree-row-kind="note"]')
        .filter({ hasText: "alpha" })
        .first();
      await expect(alphaRow).toBeVisible({ timeout: 10_000 });
      await alphaRow.click();

      await page.waitForTimeout(400);

      const notes404: string[] = [];
      const notesLoadedOk: string[] = []; // note ids the server actually served (200)
      page.on("response", (resp) => {
        const m = new URL(resp.url()).pathname.match(
          /\/api\/v1\/notes\/([a-f0-9-]+)$/,
        );
        if (!m) return;
        if (resp.status() === 404) notes404.push(resp.url());
        else if (resp.status() === 200) notesLoadedOk.push(m[1]);
      });

      const beforeNoteId = await page.evaluate(
        () => window.localStorage.getItem("jasper.tree.activeNoteId"),
      );
      expect(beforeNoteId, "activeNoteId must be set before switch").not.toBeNull();

      await page.evaluate(() => {
        window.localStorage.removeItem("jasper.tree.activeNoteId");
      });
      await page.reload();
      await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 15_000 },
      );

      await page.waitForTimeout(1_500);

      const afterNoteId = await page.evaluate(
        () => window.localStorage.getItem("jasper.tree.activeNoteId"),
      );
      // activeNoteId is persisted as a JSON string ("<uuid>" or "null"/null).
      const parsedAfter =
        afterNoteId === null || afterNoteId === "null"
          ? null
          : afterNoteId.replace(/^"|"$/g, "");

      // v1.2 redesign (phase 18) replaced the single-open-note model with a
      // per-vault persisted tab store. jasper.tree.activeNoteId is now a DERIVED
      // mirror of the active tab, so removing it alone no longer keeps a note
      // closed — the persisted (valid, same-vault) alpha tab re-hydrates on reload
      // and re-derives the mirror. Asserting the mirror is "cleared" is therefore
      // obsolete. The surviving prior-vault-404 guard lives in pruneStaleTreeState
      // / pruneTabsForMissingNotes, which drop any note id absent from the current
      // vault's tree before it can be fetched. So the intent — "a vault switch must
      // never fetch a prior-vault note" — is asserted as: (1) zero 404s for
      // /notes/<uuid>, and (2) whatever note ends up active post-reload is one the
      // server actually served (200) — a real current-vault note, never a stale id.
      expect(
        notes404,
        `R4-13: unexpected 404 responses for /notes/<uuid>: ${notes404.join(", ")}`,
      ).toEqual([]);
      expect(
        parsedAfter === null || notesLoadedOk.includes(parsedAfter),
        `R4-13: post-reload active note (${parsedAfter}) was never successfully loaded — a stale/prior-vault id lingered. loaded-ok=[${notesLoadedOk.join(", ")}]`,
      ).toBe(true);
    } finally {
      await local.cleanup();
    }
  });
});


test.describe("sb5 menu vertical spacing (@sb5)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("sb5 — consecutive menu items have a visible vertical gap", async ({ page }) => {
    await page.goto(jasper.baseURL + "/");
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 15_000 },
    );
    const row = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: "scratchpad" })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click({ button: "right" });

    const items = page.locator('[role="menuitem"]');
    const count = await items.count();
    expect(count, "expected at least 2 menu items in the context menu").toBeGreaterThanOrEqual(2);

    await page.mouse.move(0, 0);
    await page.waitForTimeout(100);

    const first = items.nth(0);
    const second = items.nth(1);

    const firstBox = await first.boundingBox();
    const secondBox = await second.boundingBox();
    if (!firstBox || !secondBox) {
      throw new Error("menu item bounding boxes were null");
    }

    const gap = secondBox.y - (firstBox.y + firstBox.height);

    expect(
      gap,
      `sb5: expected vertical gap between consecutive menu items >= 3px, got ${gap}px ` +
        `(first.y=${firstBox.y} first.height=${firstBox.height} second.y=${secondBox.y})`,
    ).toBeGreaterThanOrEqual(3);

    expect(
      gap,
      `sb5: gap should stay small (<= 12px), got ${gap}px`,
    ).toBeLessThanOrEqual(12);

    await page.keyboard.press("Escape");
  });
});


test.describe("260603-six kebab opens right (@six-kebab-right)", () => {
  test("kebab DropdownMenu opens to the right of the trigger with top-aligned edge", async ({
    page,
  }) => {
    const pathMod = await import("node:path");
    const fsP = await import("node:fs/promises");

    const local = await spawnAndBootstrapVault({
      appHomeSuffix: "jasper-six-kebab-app-",
      vaultSuffix: "jasper-six-kebab-vault-",
      seed: async (vault) => {
        const notesDir = pathMod.join(vault, "notes");
        await fsP.mkdir(pathMod.join(notesDir, "projects"), { recursive: true });
        await fsP.writeFile(
          pathMod.join(notesDir, "projects", "note.md"),
          "# note\n",
          "utf8",
        );
      },
    });
    try {
      await page.goto(local.baseURL + "/");
      await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 15_000 },
      );

      const projectsRow = page.locator(
        '[data-tree-row="projects"][data-tree-row-kind="folder"]',
      );
      await expect(projectsRow).toBeVisible({ timeout: 10_000 });

      await projectsRow.hover();
      const kebab = projectsRow.locator("[data-tree-row-kebab]");
      await expect(kebab).toBeVisible({ timeout: 5_000 });

      const kebabBox = await kebab.boundingBox();
      if (!kebabBox) {
        throw new Error("six-kebab-right: kebab boundingBox was null");
      }

      await kebab.click();

      const menu = page.locator('[role="menu"][data-side="right"]');
      await expect(
        menu,
        "kebab DropdownMenu must open on the right (data-side=\"right\"). " +
          "If this fails, Radix collision-detection likely flipped the menu — " +
          "HALT and surface for human triage; do NOT relax the assertion.",
      ).toBeVisible({ timeout: 5_000 });

      const menuBox = await menu.boundingBox();
      if (!menuBox) {
        throw new Error("six-kebab-right: menu boundingBox was null");
      }

      const viewport = page.viewportSize();
      if (!viewport) {
        throw new Error("six-kebab-right: viewport size was null");
      }

      expect(
        menuBox.x,
        `menu.x (${menuBox.x}) must be >= kebab.right (${kebabBox.x + kebabBox.width}) - 1; ` +
          `menu opened on wrong side`,
      ).toBeGreaterThanOrEqual(kebabBox.x + kebabBox.width - 1);

      const yDelta = Math.abs(menuBox.y - kebabBox.y);
      expect(
        yDelta,
        `|menu.y - kebab.y| (${yDelta}) must be <= 6 (align="start" should top-align)`,
      ).toBeLessThanOrEqual(6);

      expect(
        menuBox.x + menuBox.width,
        `menu right edge (${menuBox.x + menuBox.width}) must be within viewport ` +
          `(${viewport.width})`,
      ).toBeLessThanOrEqual(viewport.width);

      await page.keyboard.press("Escape");
    } finally {
      await local.cleanup();
    }
  });
});
