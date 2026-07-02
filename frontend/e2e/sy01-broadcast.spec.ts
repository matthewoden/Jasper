/**
 * SY-01 — two-session broadcast proof: a mutation made in one browser
 * session (tab/context) must update another session's file tree live,
 * with no manual refresh/reload on the receiving side.
 *
 * Background: SY-01 found that (1) daily-note creation bypassed
 * notes.Service and never broadcast `note:created`, and (2) /files
 * create/delete/move + attachment upload never broadcast `file:created` /
 * `file:deleted` / `file:moved`. Both were fixed to route through the
 * service/broadcaster, and useSessionSync.ts (frontend) was updated to
 * call refreshTree() on those events. The Go/handler broadcast contract
 * already has unit/integration coverage — this spec is the missing E2E
 * proof that a *second* browser session's tree actually updates.
 *
 * Two scenarios:
 *   1. Daily note (note:created): session A clicks the real "Today" toolbar
 *      button (SidebarToolbar); session B must see the new "daily" folder
 *      appear, and the new dated note inside it, without reloading.
 *   2. Attachment upload (file:created): session A uploads an attachment to
 *      a note via the attachments API (same trigger phase7-uat.spec.ts S8
 *      uses for the actual upload step — multipart POST from the page's
 *      request context); session B must see the new "attachments" folder
 *      and the uploaded file appear, without reloading.
 *
 * Both assertions poll with Playwright web-first `expect(...).toBeVisible()`
 * / `toHaveCount()` — no fixed sleeps — per the project's zero-flake policy.
 *
 * Selectors mirror existing conventions:
 *   - Tree rows: `[data-tree-row-kind="note"|"folder"|"file"]` (dnd-regression.spec.ts,
 *     phase6-uat.spec.ts S13 cross-tab pattern)
 *   - Today button: `getByRole("button", { name: "Open today's daily note" })`
 *     (phase7-uat.spec.ts S3)
 *   - Connection dot: `getByTestId("connection-status-dot")` (all specs)
 *
 * Daily note filename/title: backend `notes.GetOrCreateDailyNote` (daily.go)
 * uses relPath `daily/<date>.md` and title `<date>` where date is
 * `YYYY-MM-DD` — the same `new Date().toISOString().slice(0, 10)` the
 * frontend's useDailyNote.ts computes, so the tree row's display label
 * (title, per TreeRow.tsx's `displayLabel`) equals the test's computed
 * `todayStr` exactly.
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { apiCreateNote } from "./helpers/phase7Helpers";

let jasper: JasperHandle;

test.beforeEach(async () => {
  jasper = await spawnJasper();
});

test.afterEach(async () => {
  if (jasper) await jasper.kill();
});

/**
 * Open a new tab in the given context and wait for the WS to connect.
 *
 * Timeout is generous (20s, matching phase8-R4-2-ws-reconnect.spec.ts) —
 * under parallel `--repeat-each` / multi-worker load, several jasper
 * binaries + browser contexts boot simultaneously and the WS upgrade
 * itself has been observed taking 8s+ under contention.
 */
async function openTabInContext(ctx: BrowserContext, baseURL: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 20_000 },
  );
  return page;
}

test.describe("SY-01 — cross-session broadcast updates other session's file tree", () => {
  test("daily note created in session A appears live in session B's tree (note:created)", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openTabInContext(ctxA, jasper.baseURL);
      const pageB = await openTabInContext(ctxB, jasper.baseURL);

      // Baseline: neither session has a "daily" folder yet (fresh vault only
      // seeds root-level scratchpad.md — see lifecycle.go seedScratchpad).
      await expect(
        pageA.locator('[data-tree-row-kind="folder"]').filter({ hasText: "daily" }),
      ).toHaveCount(0);
      await expect(
        pageB.locator('[data-tree-row-kind="folder"]').filter({ hasText: "daily" }),
      ).toHaveCount(0);

      const todayStr = new Date().toISOString().slice(0, 10);

      const todayBtn = pageA.getByRole("button", { name: "Open today's daily note" });
      await expect(todayBtn).toBeVisible({ timeout: 8_000 });
      await todayBtn.click();

      // Session A opens its own editor — confirms the create actually happened.
      await expect(pageA.locator(".cm-content")).toBeVisible({ timeout: 8_000 });

      // Session B: the "daily" folder must appear WITHOUT any refresh/reload
      // on B's page — this is the live-broadcast path under test.
      const dailyFolderB = pageB
        .locator('[data-tree-row-kind="folder"]')
        .filter({ hasText: "daily" });
      await expect(dailyFolderB).toBeVisible({ timeout: 15_000 });

      await dailyFolderB.click();

      const dailyNoteRowB = pageB
        .locator('[data-tree-row-kind="note"]')
        .filter({ hasText: todayStr });
      await expect(dailyNoteRowB).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("attachment uploaded in session A appears live in session B's tree (file:created)", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openTabInContext(ctxA, jasper.baseURL);
      const pageB = await openTabInContext(ctxB, jasper.baseURL);

      // No leading H1 in the body: the H1<->filename bidirectional binding
      // (notes.Rewriter) would otherwise race-rename the tree's displayed
      // title away from the "attachment-host" filename-derived title used
      // below, which is irrelevant noise for what this test is proving.
      const noteId = await apiCreateNote(
        pageA,
        jasper.baseURL,
        "attachment-host.md",
        "",
        "Body, no heading.\n",
      );

      // Sanity: B's tree is live (note:created already proven above) and no
      // "attachments" folder exists yet — confirms the assertion below is
      // actually observing a NEW folder, not one seeded by default.
      await expect(
        pageB.locator('[data-tree-row-kind="note"]').filter({ hasText: "attachment-host" }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        pageB.locator('[data-tree-row-kind="folder"]').filter({ hasText: "attachments" }),
      ).toHaveCount(0);

      // 1x1 PNG, identical fixture bytes to phase7-uat.spec.ts S8's drag-drop
      // attachment test — that spec already validates this is a real,
      // server-accepted image upload triggering EventFileCreated
      // (attachments.go); this test uses the same multipart POST as S8's
      // actual upload step, from session A's own request context.
      const pngBytes = Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478016360000000020001e221bc330000000049454e44ae426082",
        "hex",
      );

      const uploadResp = await pageA.request.post(
        `${jasper.baseURL}/api/v1/attachments/${noteId}`,
        {
          multipart: {
            file: {
              name: "sy01-test.png",
              mimeType: "image/png",
              buffer: pngBytes,
            },
          },
        },
      );
      expect(uploadResp.status()).toBe(200);

      // Session B: the "attachments" folder must appear WITHOUT any
      // refresh/reload on B's page — this is the live-broadcast path
      // under test (file:created → refreshTree()).
      const attachmentsFolderB = pageB
        .locator('[data-tree-row-kind="folder"]')
        .filter({ hasText: "attachments" });
      await expect(attachmentsFolderB).toBeVisible({ timeout: 15_000 });

      await attachmentsFolderB.click();

      const fileRowB = pageB
        .locator('[data-tree-row-kind="file"]')
        .filter({ hasText: "sy01-test.png" });
      await expect(fileRowB).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
