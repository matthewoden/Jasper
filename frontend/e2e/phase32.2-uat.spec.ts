/**
 * Phase 32.2 UAT spec — the request-count acceptance cases from
 * `32.2-INVESTIGATION.md`'s Definition of Done (#1-#4), plus a D-07 baseline
 * census of the never-measured sibling endpoints (§ "baseline census" below).
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) at the repo root before Playwright — this spec runs against the
 * EMBEDDED Go binary, not the Vite dev server.
 *
 * DoD #6 discipline: these four cases were proven FAILING against the
 * pre-migration code before being converted to `test.fixme`. The verbatim
 * RED transcript (actual observed request counts, not a claim) is recorded
 * in `32.2-02-SUMMARY.md`. `test.fixme` reports as skipped, so the
 * committed tree stays green while the executable assertion is already in
 * place — plan 03 flips each back to `test(...)` once `useMcpGrants`/
 * `useTagBrowser` migrate onto the shared `createResource` primitive.
 *
 * Zero fixed-duration sleeps: every wait is either a Playwright
 * auto-retrying `expect`/`expect.poll`, or `settle()` from
 * `./helpers/requestCounter`, per project memory [no-flaky-tests].
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
 * Seed the scratch-vault shape `32.2-INVESTIGATION.md` measured: 12 root
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

  test.fixme(
    // Plan 03 flips this back to test(...) once useMcpGrants migrates onto
    // createResource (D-11). Pre-fix RED transcript: 32.2-02-SUMMARY.md.
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

  test.fixme(
    // Plan 03 flips this back to test(...) once useMcpGrants migrates onto
    // createResource (D-11). Pre-fix RED transcript: 32.2-02-SUMMARY.md.
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

  test.fixme(
    // Plan 03 flips this back to test(...) once useMcpGrants migrates onto
    // createResource (D-13 event-bus fan-out fix). Pre-fix RED transcript:
    // 32.2-02-SUMMARY.md.
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

  test.fixme(
    // Plan 03 flips this back to test(...) once useTagBrowser migrates onto
    // createResource (D-11). Pre-fix RED transcript: 32.2-02-SUMMARY.md.
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
 * D-07 baseline census — the never-measured sibling endpoints.
 * `32.2-INVESTIGATION.md` names `useBacklinks`/`useBookmarks` as sharing the
 * defective per-mount-fetch shape but says explicitly they were NOT part of
 * its measured evidence. This block is the before-count D-07 requires.
 *
 * Kept `test.fixme` in the committed tree — its purpose is to be run
 * manually (temporarily un-fixme'd, or via a working-tree-only edit), once
 * now (pre-migration, recorded in 32.2-02-SUMMARY.md) and once again after
 * plan 09's migration lands, so the two counts can be diffed.
 */
test.describe("@phase32.2 baseline census (D-07)", () => {
  let jasper: JasperHandle;

  test.use({ viewport: { width: 1280, height: 1400 } });

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  test.fixme(
    "census: scripted session logs a before-count for every D-07 endpoint",
    async ({ page }) => {
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

      // 3. Open the right-rail backlinks panel ("Linked mentions" tab).
      const tabRow = page.getByTestId("right-rail-tab-row");
      if ((await tabRow.count()) === 0) {
        const showPanelsBtn = page.getByRole("button", { name: "Show panels" });
        if ((await showPanelsBtn.count()) > 0) await showPanelsBtn.click();
        await expect(tabRow).toBeVisible({ timeout: 5_000 });
      }
      await tabRow.getByRole("button", { name: "Linked mentions" }).click();
      await settle(page);

      // 4. Open Settings, navigate to About.
      await page.getByTestId("settings-menu-trigger").click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await dialog.getByRole("button", { name: "About", exact: true }).click();
      await settle(page);

      // 5. Close Settings.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
      await settle(page);

      // 6. Open a split pane.
      await runCommand(page, "Split right");
      await expect(page.getByTestId("tab-strip")).toHaveCount(2, {
        timeout: 5_000,
      });
      await settle(page);

      const results: Record<string, number> = {};
      for (const [label, counter] of Object.entries(counters)) {
        results[label] = counter.count();
      }
      // This case's entire purpose is to be run manually and its console
      // output transcribed into the SUMMARY's before-count table (D-07).
      console.log("D-07 baseline census:", JSON.stringify(results, null, 2));
    },
  );
});
