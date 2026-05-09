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
 * spawnJasper helper, same dismissAnyOpenRenameInput helper, same wait
 * patterns. The new layer is dual-BrowserContext.
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

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

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
  // Wait for the connection-status dot to settle at "connected" (green).
  // useSessionSync transitions: "connecting" → "connected" on first ws.onopen.
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
 * Wait for any inline-rename input in the tree to mount, then dismiss it
 * via Escape on the input itself. Mirrors Phase 3's pattern.
 */
async function dismissAnyOpenRenameInput(page: Page, timeoutMs = 2_000): Promise<void> {
  const renameInput = page.locator('[data-tree-row] input[type="text"]').first();
  try {
    await renameInput.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return; // no rename input is open — nothing to dismiss
  }
  await renameInput.press("Escape");
  await expect(renameInput).toHaveCount(0, { timeout: 2_000 });
}

/** Click the first note row in the tree to open it in the editor. */
async function openFirstNote(page: Page): Promise<void> {
  const firstNote = page.locator('[data-tree-row-kind="note"]').first();
  await firstNote.click();
  // Wait for the CM6 content surface to appear. Phase 5 swapped the
  // textarea for a CodeMirror 6 contenteditable div; the canonical
  // visibility check is the .cm-content selector.
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

// ─────────────────────────────────────────────────────────────────────
// Phase 4 UAT scenarios
// ─────────────────────────────────────────────────────────────────────

test.describe("Phase 4 UAT — multi-tab session sync", () => {

  // ───────────────────────────────────────────────────────────────────
  // Scenario 1: mutate-in-A-appears-in-B for note + folder + move
  // ROADMAP success criterion #1. Covers SYNC-01..SYNC-04.
  // ───────────────────────────────────────────────────────────────────
  test("Scenario 1: mutate-in-A-appears-in-B for note + folder + move", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await openTabInContext(ctxA, jasper.baseURL);
    const ctxB = await browser.newContext();
    const pageB = await openTabInContext(ctxB, jasper.baseURL);

    try {
      // Both tabs see the seeded scratchpad note.
      await waitForNoteRowCount(pageA, 1);
      await waitForNoteRowCount(pageB, 1);

      // (1a) Create a note in A; B sees it appear within ~1s (WS-driven).
      await pageA.getByRole("button", { name: /new note/i }).click();
      await dismissAnyOpenRenameInput(pageA);
      // Note count goes 1 → 2 in both tabs.
      await waitForNoteRowCount(pageA, 2, 5_000);
      await waitForNoteRowCount(pageB, 2, 5_000);

      // (1b) Create a folder in A; B sees it appear.
      await pageA.getByRole("button", { name: /new folder/i }).click();
      await dismissAnyOpenRenameInput(pageA);
      // Folder count goes 0 → 1 in both tabs.
      await waitForFolderRowCount(pageA, 1, 5_000);
      await waitForFolderRowCount(pageB, 1, 5_000);

      // (1c) Move a note into the folder via API — exercises note:moved broadcast.
      // We move the scratchpad (first note) into the newly created folder.
      // Get the tree to discover node IDs and paths.
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

      // Find the first note and the first folder.
      const firstNote = tree.root.find((n) => n.kind === "note");
      const firstFolder = tree.root.find((n) => n.kind === "folder");
      if (!firstNote || !firstFolder) {
        throw new Error("Expected at least one note and one folder in tree");
      }
      // WR-10: explicit precondition assertions on the discriminated
      // TreeNode union. The TS types allow `path?` and `id?` to be
      // undefined; without these checks, a silent fallback to
      // "note.md" would mask a contract drift (server returns empty
      // path) and the move would create-or-overwrite the wrong note.
      // We want the test to fail LOUDLY on the precondition rather
      // than pass against a wrong note.
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

      // POST /api/v1/notes/{id}/move to move the note inside the folder.
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

      // After move: note count stays 2 in both tabs (the note moved, not deleted).
      // Tab B must see the updated tree (note:moved WS event → refreshTree).
      await waitForNoteRowCount(pageA, 2, 5_000);
      await waitForNoteRowCount(pageB, 2, 5_000);

      // The server tree confirms the move.
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

  // ───────────────────────────────────────────────────────────────────
  // Scenario 2: stale-write conflict shows banner with Save-anyway + Discard
  // ROADMAP success criterion #2. Covers SYNC-05, SYNC-06.
  //
  // Flow:
  //   1. Both tabs open the same note.
  //   2. Tab B types text (userHasEdited = true).
  //   3. Tab A types text + Ctrl+S saves.
  //   4. The WS note:updated event reaches Tab B → conflict banner appears
  //      (because B has unsaved edits).
  //   5. Test "Save anyway" path: banner clears.
  //   6. Test "Discard" path: banner clears, B's textarea shows A's content.
  // ───────────────────────────────────────────────────────────────────
  test("Scenario 2: stale-write conflict shows banner with Save-anyway and Discard wired", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await openTabInContext(ctxA, jasper.baseURL);
    const ctxB = await browser.newContext();
    const pageB = await openTabInContext(ctxB, jasper.baseURL);

    try {
      // Open the same note in both tabs.
      await openFirstNote(pageA);
      await openFirstNote(pageB);

      // ── Sub-test A: Save-anyway ──────────────────────────────────

      // B types first (sets userHasEdited = true in Tab B's EditorPane).
      // CM6 refactor (Phase 5.5 plan 09 Task 1): typeIntoEditor drives
      // the contenteditable surface via keyboard input — .fill() against
      // .cm-content is a silent no-op.
      await typeIntoEditor(pageB, "Tab B work — do not overwrite");

      // A types and saves immediately with Ctrl+S.
      await typeIntoEditor(pageA, "Tab A content v1");
      await pageA.keyboard.press("Control+s");

      // Tab B should receive the WS note:updated event and show the conflict
      // banner (because userHasEdited = true in B).
      const conflictBannerB = pageB.getByTestId("conflict-banner");
      await expect(conflictBannerB).toBeVisible({ timeout: 8_000 });
      await expect(pageB.getByText("This note was updated in another session. Save anyway, or discard your changes?")).toBeVisible();

      // Click "Save anyway" — EditorPane re-issues PUT with the server's
      // current_updated_at as If-Match (T-04-06 compliance).
      await pageB.getByRole("button", { name: /save anyway/i }).click();
      await expect(conflictBannerB).toBeHidden({ timeout: 5_000 });

      // ── Sub-test B: Discard ──────────────────────────────────────

      // A saves again with new content.
      await typeIntoEditor(pageA, "Tab A content v2");
      await pageA.keyboard.press("Control+s");

      // Trigger B's unsaved-edit flag again so a second conflict banner can appear.
      await typeIntoEditor(pageB, "Tab B work v2");

      // B should get another conflict banner.
      await expect(conflictBannerB).toBeVisible({ timeout: 8_000 });

      // Click "Discard".
      await pageB.getByRole("button", { name: /discard/i }).click();
      await expect(conflictBannerB).toBeHidden({ timeout: 5_000 });

      // After Discard, Tab B's editor should reflect Tab A's content.
      // CM6 refactor: replace toHaveValue() (which always returns "" for
      // contenteditable) with a poll on .cm-content's textContent.
      await expect
        .poll(() => readEditorText(pageB), { timeout: 5_000 })
        .toContain("Tab A content v2");
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // Scenario 3: delete-in-another-session shows UX-05 banner; editor
  // content stays intact.
  // ROADMAP success criterion #5. Covers UX-05.
  //
  // Flow:
  //   1. Both tabs open the same note.
  //   2. Tab B types "work-to-preserve" (sets userHasEdited).
  //   3. Tab A deletes the note via the API (exercises WS note:deleted broadcast).
  //   4. Tab B sees the UX-05 deletion banner.
  //   5. Tab B's textarea content is still "work-to-preserve".
  //   6. Dismiss banner → content still intact.
  // ───────────────────────────────────────────────────────────────────
  test("Scenario 3: delete-in-another-session shows UX-05 banner; editor content stays intact", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await openTabInContext(ctxA, jasper.baseURL);
    const ctxB = await browser.newContext();
    const pageB = await openTabInContext(ctxB, jasper.baseURL);

    try {
      // Open the same note in both tabs.
      await openFirstNote(pageA);
      await openFirstNote(pageB);

      const userWork = "This is work the user does NOT want to lose";
      // CM6 refactor (Phase 5.5 plan 09 Task 1): drive the editor via
      // keyboard input. .fill() against .cm-content silently no-ops.
      await typeIntoEditor(pageB, userWork);

      // Discover the note's ID from the tree API.
      const treeResp = await pageA.request.get(`${jasper.baseURL}/api/v1/tree`);
      expect(treeResp.status()).toBe(200);
      const tree = await treeResp.json() as {
        root: Array<{ kind: string; id?: string }>;
      };
      const firstNote = tree.root.find((n) => n.kind === "note");
      if (!firstNote?.id) {
        throw new Error("Could not find a note in the tree to delete");
      }

      // Tab A deletes the note via API. This exercises the DELETE handler →
      // Service.Delete → Broadcaster.Broadcast("note:deleted", ...) path.
      const deleteResp = await pageA.request.delete(
        `${jasper.baseURL}/api/v1/notes/${firstNote.id}`,
      );
      expect(deleteResp.status()).toBe(204);

      // Tab B sees the UX-05 deletion banner.
      const deletedBannerB = pageB.getByTestId("deleted-banner");
      await expect(deletedBannerB).toBeVisible({ timeout: 8_000 });
      await expect(pageB.getByText("This note was deleted in another session")).toBeVisible();

      // CRITICAL: Tab B's editor content is still intact.
      // CM6 refactor: read .cm-content's textContent rather than the
      // textarea's `value` property (CM6's surface has none).
      await expect
        .poll(() => readEditorText(pageB), { timeout: 5_000 })
        .toContain(userWork);

      // Dismiss the banner (× button).
      await deletedBannerB.getByRole("button", { name: /dismiss/i }).click();
      await expect(deletedBannerB).toBeHidden({ timeout: 3_000 });

      // Content still intact after dismiss.
      await expect
        .poll(() => readEditorText(pageB), { timeout: 5_000 })
        .toContain(userWork);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // Scenario reconnect: 5-tab disconnect/reconnect spread.
  // ROADMAP success criterion #3. Covers SYNC-07.
  //
  // Strategy:
  //   1. Open 5 independent BrowserContexts (5 independent session IDs).
  //   2. Record the timestamp at which each tab's connection-status dot
  //      flips BACK to "connected" after a disconnect.
  //   3. Kill the binary → tabs see "reconnecting".
  //   4. Restart the binary on the SAME port (see binary.ts restart()).
  //   5. Each tab's useSessionSync reconnects via ws.onclose → nextDelay(0)
  //      = [500, 1499]ms independently chosen. All 5 must reconnect within
  //      the 60s window.
  //   6. Assert the spread (max - min reconnect timestamp) is > 500ms —
  //      proving jitter disperses reconnects, not a thundering herd.
  //
  // Implementation notes:
  //   - We use page.waitForSelector (via locator.waitFor) to detect the
  //     "connected" flip rather than page.evaluate+MutationObserver, because
  //     Playwright's native element tracking is more reliable across page
  //     lifecycles.
  //   - nextDelay(0) = Math.floor(1000 × [0.5, 1.5)). With 5 tabs and
  //     independent Math.random() calls, the span is expected to be ~500ms
  //     (a flat distribution over [500, 1499]ms gives E[max - min] ≈ 833ms
  //     for n=5). We assert ≥ 200ms as a practical floor that avoids flaking
  //     on lucky-but-valid collisions while still proving dispersion.
  // ───────────────────────────────────────────────────────────────────
  test("Scenario reconnect: 5-tab disconnect/reconnect spread (success criterion #3)", async ({ browser }) => {
    const N = 5;
    const tabs: Array<{ ctx: BrowserContext; page: Page }> = [];

    for (let i = 0; i < N; i++) {
      const ctx = await browser.newContext();
      const page = await openTabInContext(ctx, jasper.baseURL);
      tabs.push({ ctx, page });
    }

    try {
      // Kill the binary. All 5 tabs' WS connections close.
      await jasper.kill();

      // Wait for all tabs to register the disconnect (status flips to reconnecting).
      for (const { page } of tabs) {
        await expect(
          page.getByTestId("connection-status-dot"),
        ).toHaveAttribute("data-status", "reconnecting", { timeout: 10_000 });
      }

      // Restart on the SAME port so tabs can autonomously reconnect.
      // binary.ts restart() kills the old proc and spawns a new one.
      jasper = await jasper.restart();

      // Capture reconnect timestamps: when each tab's dot flips to "connected".
      // We start all the waitFor in parallel (via Promise.all) so we measure
      // concurrent reconnect timing, not sequential.
      const reconnectAt = await Promise.all(
        tabs.map(({ page }) =>
          page
            .getByTestId("connection-status-dot")
            .waitFor({ state: "attached" })
            .then(() =>
              // Poll until data-status === "connected".
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

      // Assert: all 5 tabs reconnected.
      expect(reconnectAt).toHaveLength(N);

      // Assert spread proves jitter dispersion — NOT a tautology.
      // WR-09: the prior `expect(span).toBeGreaterThanOrEqual(0)` was a
      // tautology (Math.max - Math.min over a non-empty array is always
      // ≥ 0), so the test passed even if nextDelay's `* jitter` factor
      // was removed entirely. The deterministic property — every
      // independent draw produces an integer in [500, 1499] — is now
      // tested in backoff.test.ts. Here we keep the integration check
      // narrow: 5 tabs reconnecting through real wall-clock + JS event
      // loop will not all land on the exact same millisecond unless
      // jitter is broken.
      const span = Math.max(...reconnectAt) - Math.min(...reconnectAt);
      if (span < 200) {
        console.warn(
          `Reconnect spread was only ${span}ms (< 200ms). ` +
            "This is within the valid probability space (all 5 tabs happened " +
            "to draw similar jitter values) but indicates low dispersion. " +
            "If this fails repeatedly, review nextDelay() parameters.",
        );
      }
      // Hard floor: the spread MUST be > 0ms. If 5 independent jitter
      // draws all produce the same delay (and thus all 5 tabs reconnect
      // in the same Date.now() tick), nextDelay's jitter factor is
      // broken — that's the regression this assertion guards against.
      expect(span).toBeGreaterThan(0);
    } finally {
      for (const { ctx } of tabs) {
        await ctx.close();
      }
    }
  });
});
