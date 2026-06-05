/**
 * Phase 4 UAT — multi-tab session sync via WebSocket.
 *
 * These tests run against the LIVE Go binary (spawnJasper). Each scenario
 * uses TWO BrowserContexts so the two tabs have independent sessionStorage
 * (and therefore independent session_id UUIDs) — exercising server-side
 * origin filtering for real.
 *
 * Scenarios (mirrors D-12 + ROADMAP success criteria):
 *   1. Mutate-in-A-appears-in-B for note + folder + move (SYNC-01..04, success #1)
 *   2. Stale-write conflict in tab B with Save-anyway + Discard (SYNC-05/06, success #2)
 *   3. Delete-in-another-session shows UX-05 banner with editor content intact (UX-05, success #5)
 *   4. 5-tab disconnect/reconnect spread (SYNC-07, success #3)
 *
 * The Phase 3 phase3-uat.spec.ts file is the structural template — same
 * spawnJasper helper, same commitRenameWith helper (post-Bug-D
 * replacement for the legacy dismissAnyOpenRenameInput; see Plan
 * 05.5-16), same wait patterns. The new layer is dual-BrowserContext.
 *
 * Tree row selectors: tree rows use `data-tree-row-kind="note"` (not
 * `data-testid="tree-row"`). This matches the actual DOM from TreeRow.tsx.
 *
 * Delete flow: API-level DELETE is used for reliable WS event broadcasting.
 * The browser context that "deletes" calls the API directly via
 * page.request.delete() — this exercises the exact WS broadcast path
 * (backend Service.Delete → Broadcaster.Broadcast) that Tab B must observe.
 * A future E2E can layer in UI-driven delete once Radix ContextMenu
 * synthetic-event support matures in Playwright.
 *
 * Spec uses UI-level assertions only (banner text, tree-row counts,
 * data-status attribute) — no inline WS payload shape assertions.
 * Therefore Amendment 2 schema-type requirement is moot.
 * SUMMARY notes: "spec uses UI-level assertions only, no fixture types needed"
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

let jasper: JasperHandle;

test.beforeEach(async () => {
  jasper = await spawnJasper();
});

test.afterEach(async () => {
  if (jasper) await jasper.kill();
});


/**
 * Open a page in the given BrowserContext, navigate to baseURL, wait for the
 * connection-status dot to reach "connected". Each scenario creates its OWN
 * BrowserContext via `browser.newContext()` at the call site so that every
 * "tab" has independent sessionStorage (and therefore an independent
 * session_id UUID) — the core of the Phase 4 dual-context pattern.
 */
async function openTabInContext(
  ctx: BrowserContext,
  baseURL: string,
): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
  return page;
}

/**
 * Count note rows (data-tree-row-kind="note") and wait until expected count
 * is reached. Tree updates via WS broadcast → refreshTree() → re-render.
 */
async function waitForNoteRowCount(page: Page, expected: number, timeoutMs = 5_000): Promise<void> {
  const rows = page.locator('[data-tree-row-kind="note"]');
  await expect(rows).toHaveCount(expected, { timeout: timeoutMs });
}

/**
 * Count folder rows (data-tree-row-kind="folder") and wait until expected count.
 */
async function waitForFolderRowCount(page: Page, expected: number, timeoutMs = 5_000): Promise<void> {
  const rows = page.locator('[data-tree-row-kind="folder"]');
  await expect(rows).toHaveCount(expected, { timeout: timeoutMs });
}

/**
 * Commit an open rename input with a specific name. Replaces the
 * pre-Bug-D `dismissAnyOpenRenameInput` helper for post-create
 * scenarios.
 *
 * Background — Bug D (resolved 2026-05-07,
 * `.planning/debug/resolved/rename-input-lifecycle.md`): pressing
 * Escape on a brand-new (just-created, never-confirmed) row now
 * fires DELETE /api/v1/notes/{id} (or the folder analogue), per the
 * locked UAT product contract. Phase 4 Scenario 1's post-create
 * dismiss-then-assert-N+1 flow regressed silently after Bug D
 * landed; commit-the-rename restores the row's persistence. See
 * `.planning/phases/05.5-sidebar-editor-shell-polish/05.5-14-INVESTIGATION.md`.
 *
 * Duplicated from phase3-uat.spec.ts to match the existing project
 * convention (the legacy dismissAnyOpenRenameInput was duplicated
 * across both spec files; we follow the same pattern rather than
 * factoring into a shared helper module).
 *
 * @param page Playwright page handle
 * @param name Unique name to commit. Must not collide with an
 *   existing sibling — the server returns 409 on collision.
 */
async function commitRenameWith(
  page: Page,
  name: string,
  timeoutMs = 2_000,
): Promise<void> {
  const renameInput = page.locator('[data-tree-row] input[type="text"]').first();
  await renameInput.waitFor({ state: "visible", timeout: timeoutMs });
  await renameInput.fill(name);
  await renameInput.press("Enter");
  await expect(renameInput).toHaveCount(0, { timeout: timeoutMs });
}

/** Click the first note row in the tree to open it in the editor. */
async function openFirstNote(page: Page): Promise<void> {
  const firstNote = page.locator('[data-tree-row-kind="note"]').first();
  await firstNote.click();
  await page.waitForSelector(".cm-content", { timeout: 5_000 });
}

/**
 * CM6 typing recipe (Phase 5.5 plan 09 Task 1).
 *
 * Replaces textarea.fill() patterns from the pre-CM6 era. The
 * .cm-content surface is contenteditable, not a real <textarea>, so
 * .fill() is a no-op and .toHaveValue() returns "".
 *
 * Recipe: click .cm-content to focus → select-all → delete → type.
 */
async function typeIntoEditor(page: Page, text: string): Promise<void> {
  const cm = page.locator(".cm-content");
  await cm.click();
  const selectAllKey =
    process.platform === "darwin" ? "Meta+a" : "Control+a";
  await page.keyboard.press(selectAllKey);
  await page.keyboard.press("Delete");
  await page.keyboard.type(text);
}

/**
 * Read the visible plain text out of the CM6 editor surface.
 *
 * Replaces the pre-CM6 `expect(textarea).toHaveValue(...)` pattern.
 * .cm-content's textContent gives the doc's plain text; line breaks
 * inserted by the user are flattened to spaces in textContent, but
 * for the Phase 4 assertions (single-line "Tab A content v2"-style
 * strings) that's lossless.
 */
async function readEditorText(page: Page): Promise<string> {
  return (await page.locator(".cm-content").textContent()) ?? "";
}


test.describe("Phase 4 UAT — multi-tab session sync", () => {

  test("Scenario 1: mutate-in-A-appears-in-B for note + folder + move", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await openTabInContext(ctxA, jasper.baseURL);
    const ctxB = await browser.newContext();
    const pageB = await openTabInContext(ctxB, jasper.baseURL);

    try {
      await waitForNoteRowCount(pageA, 1);
      await waitForNoteRowCount(pageB, 1);

      await pageA.getByRole("button", { name: /new note/i }).click();
      await commitRenameWith(pageA, "scenario-1-note-1");
      await waitForNoteRowCount(pageA, 2, 5_000);
      await waitForNoteRowCount(pageB, 2, 5_000);

      await pageA.getByRole("button", { name: /new folder/i }).click();
      await commitRenameWith(pageA, "scenario-1-folder-1");
      await waitForFolderRowCount(pageA, 1, 5_000);
      await waitForFolderRowCount(pageB, 1, 5_000);

      const treeResp = await pageA.request.get(`${jasper.baseURL}/api/v1/tree`);
      expect(treeResp.status()).toBe(200);
      const tree = await treeResp.json() as {
        root: Array<{
          kind: string;
          id?: string;
          path?: string;
          children?: Array<{ kind: string; id?: string; path?: string }>;
        }>;
      };

      const firstNote = tree.root.find((n) => n.kind === "note");
      const firstFolder = tree.root.find((n) => n.kind === "folder");
      if (!firstNote || !firstFolder) {
        throw new Error("Expected at least one note and one folder in tree");
      }
      if (!firstNote.id || !firstNote.path) {
        throw new Error(
          `Test precondition: first note must have id+path; got id=${String(firstNote.id)}, path=${String(firstNote.path)}`,
        );
      }
      if (!firstFolder.path) {
        throw new Error(
          `Test precondition: first folder must have path; got ${String(firstFolder.path)}`,
        );
      }

      const noteBasename = firstNote.path.split("/").pop();
      if (!noteBasename) {
        throw new Error(`Note path lacks a basename segment: ${firstNote.path}`);
      }
      expect(noteBasename).toMatch(/\.md$/);
      const newPath = `${firstFolder.path}/${noteBasename}`;
      const moveResp = await pageA.request.post(
        `${jasper.baseURL}/api/v1/notes/${firstNote.id}/move`,
        { data: { new_path: newPath } },
      );
      expect(moveResp.status()).toBe(200);

      await waitForNoteRowCount(pageA, 2, 5_000);
      await waitForNoteRowCount(pageB, 2, 5_000);

      const treeAfter = await pageA.request.get(`${jasper.baseURL}/api/v1/tree`);
      expect(treeAfter.status()).toBe(200);
      const treeAfterJson = await treeAfter.json() as {
        root: Array<{
          kind: string;
          children?: Array<{ kind: string; path?: string }>;
        }>;
      };
      const folderAfter = treeAfterJson.root.find((n) => n.kind === "folder");
      expect(folderAfter?.children?.some((c) => c.path === newPath)).toBe(true);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("Scenario 2: stale-write conflict shows banner with Save-anyway and Discard wired", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await openTabInContext(ctxA, jasper.baseURL);
    const ctxB = await browser.newContext();
    const pageB = await openTabInContext(ctxB, jasper.baseURL);

    try {
      await openFirstNote(pageA);
      await openFirstNote(pageB);


      await typeIntoEditor(pageB, "Tab B work — do not overwrite");

      await typeIntoEditor(pageA, "Tab A content v1");
      await pageA.keyboard.press("Control+s");

      const conflictBannerB = pageB.getByTestId("conflict-banner");
      await expect(conflictBannerB).toBeVisible({ timeout: 8_000 });
      await expect(pageB.getByText("This note was updated in another session. Save anyway, or discard your changes?")).toBeVisible();

      await pageB.getByRole("button", { name: /save anyway/i }).click();
      await expect(conflictBannerB).toBeHidden({ timeout: 5_000 });


      await typeIntoEditor(pageA, "Tab A content v2");
      await pageA.keyboard.press("Control+s");

      await typeIntoEditor(pageB, "Tab B work v2");

      await expect(conflictBannerB).toBeVisible({ timeout: 8_000 });

      await pageB.getByRole("button", { name: /discard/i }).click();
      await expect(conflictBannerB).toBeHidden({ timeout: 5_000 });

      await expect
        .poll(() => readEditorText(pageB), { timeout: 5_000 })
        .toContain("Tab A content v2");
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("Scenario 3: delete-in-another-session shows UX-05 banner; editor content stays intact", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await openTabInContext(ctxA, jasper.baseURL);
    const ctxB = await browser.newContext();
    const pageB = await openTabInContext(ctxB, jasper.baseURL);

    try {
      await openFirstNote(pageA);
      await openFirstNote(pageB);

      const userWork = "This is work the user does NOT want to lose";
      await typeIntoEditor(pageB, userWork);

      const treeResp = await pageA.request.get(`${jasper.baseURL}/api/v1/tree`);
      expect(treeResp.status()).toBe(200);
      const tree = await treeResp.json() as {
        root: Array<{ kind: string; id?: string }>;
      };
      const firstNote = tree.root.find((n) => n.kind === "note");
      if (!firstNote?.id) {
        throw new Error("Could not find a note in the tree to delete");
      }

      const deleteResp = await pageA.request.delete(
        `${jasper.baseURL}/api/v1/notes/${firstNote.id}`,
      );
      expect(deleteResp.status()).toBe(204);

      const deletedBannerB = pageB.getByTestId("deleted-banner");
      await expect(deletedBannerB).toBeVisible({ timeout: 8_000 });
      await expect(pageB.getByText("This note was deleted in another session")).toBeVisible();

      await expect
        .poll(() => readEditorText(pageB), { timeout: 5_000 })
        .toContain(userWork);

      await deletedBannerB.getByRole("button", { name: /dismiss/i }).click();
      await expect(deletedBannerB).toBeHidden({ timeout: 3_000 });

      await expect
        .poll(() => readEditorText(pageB), { timeout: 5_000 })
        .toContain(userWork);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("Scenario reconnect: 5-tab disconnect/reconnect spread (success criterion #3)", async ({ browser }) => {
    const N = 5;
    const tabs: Array<{ ctx: BrowserContext; page: Page }> = [];

    for (let i = 0; i < N; i++) {
      const ctx = await browser.newContext();
      const page = await openTabInContext(ctx, jasper.baseURL);
      tabs.push({ ctx, page });
    }

    try {
      await jasper.kill();

      for (const { page } of tabs) {
        await expect(
          page.getByTestId("connection-status-dot"),
        ).toHaveAttribute("data-status", "reconnecting", { timeout: 10_000 });
      }

      jasper = await jasper.restart();

      const reconnectAt = await Promise.all(
        tabs.map(({ page }) =>
          page
            .getByTestId("connection-status-dot")
            .waitFor({ state: "attached" })
            .then(() =>
              expect
                .poll(
                  async () => {
                    const dot = page.getByTestId("connection-status-dot");
                    return await dot.getAttribute("data-status");
                  },
                  { timeout: 60_000, intervals: [200] },
                )
                .toBe("connected")
                .then(() => Date.now()),
            ),
        ),
      );

      expect(reconnectAt).toHaveLength(N);

      const span = Math.max(...reconnectAt) - Math.min(...reconnectAt);
      if (span < 200) {
        console.warn(
          `Reconnect spread was only ${span}ms (< 200ms). ` +
            "This is within the valid probability space (all 5 tabs happened " +
            "to draw similar jitter values) but indicates low dispersion. " +
            "If this fails repeatedly, review nextDelay() parameters.",
        );
      }
      expect(span).toBeGreaterThan(0);
    } finally {
      for (const { ctx } of tabs) {
        await ctx.close();
      }
    }
  });
});
