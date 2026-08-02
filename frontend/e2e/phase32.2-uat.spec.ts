/**
 * Request-count acceptance cases plus a standing-budget census of sibling
 * endpoints.
 *
 * All four cases were proven FAILING against the pre-migration code before
 * useMcpGrants and useTagBrowser moved onto createResource — the counts below are
 * measured, not chosen.
 *
 * Every wait is an auto-retrying expect/expect.poll or settle() from
 * ./helpers/requestCounter — never a fixed-duration sleep.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { apiCreateNote, waitForConnected } from "./helpers/phase7Helpers";
import { openNoteFromTree } from "./helpers/openNoteFromTree";
import { countRequests, settle } from "./helpers/requestCounter";

const GRANTS_PATTERN = /\/api\/v1\/mcp\/grants(?:\?|$)/;
const TAGS_PATTERN = /\/api\/v1\/tags(?:\?|$)/;

async function apiCreateFolder(
  page: Page,
  baseURL: string,
  name: string,
  parentPath = "",
): Promise<void> {
  const resp = await page.request.post(`${baseURL}/api/v1/folders`, {
    data: { parent_path: parentPath, name },
  });
  if (resp.status() !== 201) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateFolder ${name}: ${String(resp.status())} ${body}`,
    );
  }
}

/**
 * Seed the scratch-vault shape measured: 12 root
 * folders + 9 root notes (21 initial tree rows). 4 of the 12 folders each
 * get one child note, so expanding all 12 folders reveals exactly 4
 * additional rows — matching the measured "25 rows after expand" baseline.
 * Returns the id of the first root note, for tests that need to open one.
 */
async function seedInvestigationVault(
  page: Page,
  baseURL: string,
): Promise<{ firstNoteId: string }> {
  for (let i = 1; i <= 12; i++) {
    await apiCreateFolder(page, baseURL, `folder-${String(i).padStart(2, "0")}`);
  }
  for (let i = 1; i <= 4; i++) {
    const folderName = `folder-${String(i).padStart(2, "0")}`;
    await apiCreateNote(
      page,
      baseURL,
      `child-${String(i).padStart(2, "0")}.md`,
      folderName,
      `child note ${String(i)}`,
    );
  }
  let firstNoteId = "";
  for (let i = 1; i <= 9; i++) {
    const id = await apiCreateNote(
      page,
      baseURL,
      `root-note-${String(i).padStart(2, "0")}.md`,
      "",
      `root note ${String(i)}`,
    );
    if (i === 1) firstNoteId = id;
  }
  return { firstNoteId };
}

/** Navigate to baseURL and wait for the WS dot to flip to "connected". */
async function openApp(page: Page, jasper: JasperHandle): Promise<void> {
  await page.goto(jasper.baseURL);
  await waitForConnected(page);
}

/** Open the Cmd+P command palette and run a command by its exact label. */
async function runCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Meta+p");
  const input = page.getByPlaceholder("Type a command…");
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(label);
  const row = page
    .locator('[data-row-kind="cmd"]')
    .filter({ hasText: label })
    .first();
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.click();
}

test.describe("@phase32.2 DoD request-count acceptance", () => {
  let jasper: JasperHandle;

  test.use({ viewport: { width: 1280, height: 1400 } });

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  test(
    "grants: page load issues 1 request",
    async ({ page }) => {
      await seedInvestigationVault(page, jasper.baseURL);
      const grants = countRequests(page, GRANTS_PATTERN);

      await openApp(page, jasper);
      await settle(page);

      await expect
        .poll(() => grants.count(), {
          message: `observed GET /api/v1/mcp/grants URLs: ${JSON.stringify(grants.urls())}`,
        })
        .toBe(1);
    },
  );

  test(
    "grants: folder expand issues 0 additional",
    async ({ page }) => {
      await seedInvestigationVault(page, jasper.baseURL);
      const grants = countRequests(page, GRANTS_PATTERN);

      await openApp(page, jasper);
      await settle(page);
      const baseline = grants.count();

      const folderRows = page.locator('[data-tree-row-kind="folder"]');
      const folderCount = await folderRows.count();
      expect(folderCount, "expected all 12 seeded folders to be visible").toBe(12);
      for (let i = 0; i < folderCount; i++) {
        const row = folderRows.nth(i);
        await row.click();
        await expect(row).toHaveAttribute("aria-expanded", "true", {
          timeout: 3_000,
        });
      }
      await settle(page);

      const delta = grants.count() - baseline;
      expect(
        delta,
        `baseline=${String(baseline)}, final=${String(grants.count())}, URLs: ${JSON.stringify(grants.urls())}`,
      ).toBe(0);
    },
  );

  test(
    // (event-bus fan-out fix).
    "grants: one WS event issues 1 refetch",
    async ({ page, context }) => {
      await seedInvestigationVault(page, jasper.baseURL);
      const grants = countRequests(page, GRANTS_PATTERN);

      await openApp(page, jasper);
      await settle(page);
      const baseline = grants.count();

      // SECOND page context, so the mutation's X-Session-ID header (see
      // sessionId.ts) cannot match the observing page's own session and the
      // server-side origin filter does not suppress the broadcast.
      const secondPage = await context.newPage();
      const grantResp = await secondPage.request.post(
        `${jasper.baseURL}/api/v1/mcp/grants`,
        { data: { folder_path: "folder-01", level: 1 } },
      );
      expect(
        grantResp.status(),
        await grantResp.text().catch(() => "(no body)"),
      ).toBe(200);
      await secondPage.close();

      await settle(page);
      const delta = grants.count() - baseline;
      expect(
        delta,
        `baseline=${String(baseline)}, final=${String(grants.count())}, URLs: ${JSON.stringify(grants.urls())}`,
      ).toBe(1);
    },
  );

  test(
    "tags: split pane issues 1 request",
    async ({ page }) => {
      const { firstNoteId } = await seedInvestigationVault(page, jasper.baseURL);
      const tags = countRequests(page, TAGS_PATTERN);

      await openApp(page, jasper);
      await openNoteFromTree(page, firstNoteId);
      await settle(page);

      await runCommand(page, "Split right");
      await expect(page.getByTestId("tab-strip")).toHaveCount(2, {
        timeout: 5_000,
      });
      await settle(page);

      await expect
        .poll(() => tags.count(), {
          message: `observed GET /api/v1/tags URLs: ${JSON.stringify(tags.urls())}`,
        })
        .toBe(1);
    },
  );
});

/**
 * Standing per-endpoint request budget. The ESLint gate catches a NEW raw
 * client.GET, but structurally cannot catch a new mount effect calling an
 * already-legitimate wrapper — only a request-count assertion closes that half.
 *
 * Ceilings are measured AFTER counts against the migrated binary, not guesses.
 * `toBe` wherever the migration makes the count deterministic;
 * `toBeLessThanOrEqual` only for /tree, which carries a genuine race window where
 * a joiner arriving mid-fetch can cost one extra GET.
 */
test.describe("@phase32.2 standing request budget", () => {
  let jasper: JasperHandle;

  test.use({ viewport: { width: 1280, height: 1400 } });

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  test("scripted session stays within the per-endpoint request budget", async ({
    page,
  }) => {
    const endpoints: Record<string, RegExp> = {
      "GET /mcp/grants": GRANTS_PATTERN,
      "GET /tags": TAGS_PATTERN,
      "GET /tree": /\/api\/v1\/tree(?:\?|$)/,
      "GET /bookmarks": /\/api\/v1\/bookmarks(?:\?|$)/,
      "GET /notes/{id}/backlinks": /\/api\/v1\/notes\/[^/]+\/backlinks(?:\?|$)/,
      "GET /vault/about": /\/api\/v1\/vault\/about(?:\?|$)/,
      "GET /vault/workspace": /\/api\/v1\/vault\/workspace(?:\?|$)/,
      "GET /config": /\/api\/v1\/config(?:\?|$)/,
      "GET /vault/current": /\/api\/v1\/vault\/current(?:\?|$)/,
      "GET /vault/recent": /\/api\/v1\/vault\/recent(?:\?|$)/,
      "GET /admin/status": /\/api\/v1\/admin\/status(?:\?|$)/,
    };

    const { firstNoteId } = await seedInvestigationVault(page, jasper.baseURL);
    const counters = Object.fromEntries(
      Object.entries(endpoints).map(([label, pattern]) => [
        label,
        countRequests(page, pattern),
      ]),
    );

    // 1. Open the app.
    await openApp(page, jasper);
    await settle(page);

    // 2. Open a note.
    await openNoteFromTree(page, firstNoteId);
    await settle(page);

    // 3. Expand every folder.
    const folderRows = page.locator('[data-tree-row-kind="folder"]');
    const folderCount = await folderRows.count();
    expect(folderCount, "expected all 12 seeded folders to be visible").toBe(12);
    for (let i = 0; i < folderCount; i++) {
      const row = folderRows.nth(i);
      await row.click();
      await expect(row).toHaveAttribute("aria-expanded", "true", {
        timeout: 3_000,
      });
    }
    await settle(page);

    // 4. Open the right-rail backlinks panel ("Linked mentions" tab).
    const tabRow = page.getByTestId("right-rail-tab-row");
    if ((await tabRow.count()) === 0) {
      const showPanelsBtn = page.getByRole("button", { name: "Show panels" });
      if ((await showPanelsBtn.count()) > 0) await showPanelsBtn.click();
      await expect(tabRow).toBeVisible({ timeout: 5_000 });
    }
    await tabRow.getByRole("button", { name: "Linked mentions" }).click();
    await settle(page);

    // 5. Open the right-rail tag panel — a second, independent
    // useTagBrowser() mount site alongside the editor pane's.
    await tabRow.getByRole("button", { name: "Tags" }).click();
    await settle(page);

    // 6. Open Settings, navigate to About.
    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole("button", { name: "About", exact: true }).click();
    await settle(page);

    // 7. Close Settings.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    await settle(page);

    // 8. Open a split pane — a third useTagBrowser()/second
    // useBookmarks()/useFileTree() mount site.
    await runCommand(page, "Split right");
    await expect(page.getByTestId("tab-strip")).toHaveCount(2, {
      timeout: 5_000,
    });
    await settle(page);

    const results: Record<string, number> = {};
    for (const [label, counter] of Object.entries(counters)) {
      results[label] = counter.count();
    }
    // Printed unconditionally so a CI failure's actual counts are visible
    // in the log without re-running locally.
    console.log("standing budget — observed counts:", JSON.stringify(results, null, 2));

    // Cached singleton resources: first-subscriber-triggers-fetch
    // means N mount sites (TreeRow x21, editor pane(s), right-rail panel,
    // settings shell) share exactly one fetch — no invalidating WS event
    // fires in this session (no grant/tag/bookmark/note/folder mutation
    // through the UI). These exact-1 counts were measured against the
    // migrated binary for the grants/tags DoD cases.
    expect(results["GET /mcp/grants"], JSON.stringify(counters["GET /mcp/grants"].urls())).toBe(1);
    expect(results["GET /tags"], JSON.stringify(counters["GET /tags"].urls())).toBe(1);

    // Cached singletons closed by plans 05/06/07 — each plan's own
    // Before/After table recorded the post-migration count as exactly 1.
    expect(results["GET /bookmarks"], JSON.stringify(counters["GET /bookmarks"].urls())).toBe(1);
    expect(results["GET /vault/workspace"], JSON.stringify(counters["GET /vault/workspace"].urls())).toBe(1);
    expect(results["GET /vault/about"], JSON.stringify(counters["GET /vault/about"].urls())).toBe(1);
    expect(results["GET /notes/{id}/backlinks"], JSON.stringify(counters["GET /notes/{id}/backlinks"].urls())).toBe(1);

    // Boot-scoped /config — one shared fetch across every
    // useConfig() mount site (App.tsx, SettingsDialogShell.tsx); no WS
    // invalidation exists for config, so it never refetches mid-session.
    expect(results["GET /config"], JSON.stringify(counters["GET /config"].urls())).toBe(1);

    // Pass-through singletons (amended) — coalesced, never cached,
    // called imperatively from TWO independent, legitimate boot-time
    // mount sites that don't overlap in time (so they don't coalesce):
    // App.tsx's BootGate (its own inline getCurrent() call) AND
    // useVaultPicker() — hoisted by StatusBar.tsx/ActivityRibbon.tsx for
    // the vault-switcher menu, which is mounted even when a vault is
    // already open, not just inside <VaultPicker>. useVaultPicker.ts
    // fires both getCurrent() and getRecent() together
    // (Promise.all), so /vault/current sees both call sites (2) while
    // /vault/recent sees only useVaultPicker's (1). Measured against the
    // migrated binary, not assumed — the mount site was not obvious from
    // this file's own imports alone.
    expect(results["GET /vault/current"], JSON.stringify(counters["GET /vault/current"].urls())).toBe(2);
    expect(results["GET /vault/recent"], JSON.stringify(counters["GET /vault/recent"].urls())).toBe(1);

    // Cached, invalidatedBy: ["reindex:complete"] (amended) — one
    // useMigrationStatus() mount site (App.tsx); no reindex runs in this
    // session.
    expect(results["GET /admin/status"], JSON.stringify(counters["GET /admin/status"].urls())).toBe(1);

    // /tree carries a genuine race window (commit 7494174d /
    // phase5_5-uat.spec.ts): a read that joins an
    // in-flight fetch is occasionally followed by one extra never-join
    // fetch if an invalidation lands in the same window. Measured
    // 2 for a session ending in a split pane (mount fetch + one further
    // legitimate fetch from the second useFileTree()-subscribing screen
    // transition); this session adds folder-expand and tag-panel steps
    // that read the already-hydrated cache and do not themselves fetch.
    expect(
      results["GET /tree"],
      JSON.stringify(counters["GET /tree"].urls()),
    ).toBeLessThanOrEqual(3);
  });
});
