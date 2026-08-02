/**
 * Proves a mutation in one browser session updates a SECOND session's file tree
 * live. The Go broadcast contract already has unit coverage; what was missing is
 * the browser-to-browser half.
 *
 * The expected daily-note date is derived through helpers/localDate.ts, not
 * toISOString() — the backend names the file from the frontend's LOCAL calendar
 * date, so a UTC date fails for several hours each evening.
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { apiCreateNote } from "./helpers/phase7Helpers";
import { localDateString } from "./helpers/localDate";

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

test.describe("cross-session broadcast updates other session's file tree", () => {
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

      const todayStr = localDateString();

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
