/**
 * multi-tab session sync via WebSocket.
 *
 * Each scenario uses two BrowserContexts so the tabs have independent
 * sessionStorage (and therefore independent session_id UUIDs) — exercising
 * server-side origin filtering for real.
 *
 * Scenarios:
 *   1. Mutate-in-A-appears-in-B for note + folder + move
 *   2. Stale-write conflict in tab B with Save-anyway + Discard
 *   3. Delete-in-another-session freezes the tab read-only with a "(deleted)"
 *      indicator; editor content stays intact (v1.2)
 *   4. 5-tab disconnect/reconnect spread
 *
 * Tree rows use `data-tree-row-kind="note"` (not `data-testid="tree-row"`).
 *
 * Delete flow: API-level DELETE is used for reliable WS event broadcasting;
 * this exercises the exact broadcast path (Service.Delete → Broadcaster)
 * that Tab B must observe.
 *
 * Spec uses UI-level assertions only — no WS payload shape assertions.
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
 * BrowserContext so that every "tab" has independent sessionStorage (and
 * therefore an independent session_id UUID).
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
 * Commit an open rename input with a specific name.
 *
 * Pressing Escape on a brand-new (never-confirmed) row fires DELETE —
 * always use Enter so the row persists.
 *
 * Duplicated from phase3-uat.spec.ts (inline per file rather than a shared
 * helper module, following the convention established for this suite).
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
 * CM6 typing recipe: click .cm-content to focus → select-all → delete → type.
 *
 * .fill() is a no-op on contenteditable; .toHaveValue() returns "".
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
 * .cm-content's textContent gives the doc's plain text; line breaks are
 * flattened to spaces, which is lossless for single-line assertions.
 */
async function readEditorText(page: Page): Promise<string> {
  return (await page.locator(".cm-content").textContent()) ?? "";
}


test.describe("multi-tab session sync", () => {

  test("Scenario 1: mutate-in-A-appears-in-B for note + folder + move", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await openTabInContext(ctxA, jasper.baseURL);
    const ctxB = await browser.newContext();
    const pageB = await openTabInContext(ctxB, jasper.baseURL);

    try {
      await waitForNoteRowCount(pageA, 1);
      await waitForNoteRowCount(pageB, 1);

      // Cross-tab WS-sync waits use a generous 15s deadline: at workers:4 the
      // broadcast → refetch → re-render chain in the OTHER tab competes with
      // many concurrent binaries for CPU and can exceed a 5s window. Still a
      // poll-for-eventual-condition, not a fixed sleep.
      await pageA.getByRole("button", { name: /new note/i }).click();
      await commitRenameWith(pageA, "scenario-1-note-1");
      await waitForNoteRowCount(pageA, 2, 15_000);
      await waitForNoteRowCount(pageB, 2, 15_000);

      await pageA.getByRole("button", { name: /new folder/i }).click();
      await commitRenameWith(pageA, "scenario-1-folder-1");
      await waitForFolderRowCount(pageA, 1, 15_000);
      await waitForFolderRowCount(pageB, 1, 15_000);

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

      await waitForNoteRowCount(pageA, 2, 15_000);
      await waitForNoteRowCount(pageB, 2, 15_000);

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


      // Mirror round 1's ordering: B must have a PENDING edit (userHasEdited=true)
      // BEFORE A's save broadcasts note:updated. Otherwise A's broadcast can reach
      // B while userHasEdited=false (Save-anyway just reset it) and B silently
      // adopts A's version — no conflict. Type in B first, then save in A.
      await typeIntoEditor(pageB, "Tab B work v2");

      await typeIntoEditor(pageA, "Tab A content v2");
      await pageA.keyboard.press("Control+s");

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

  test("Scenario 3: delete-in-another-session shows the deleted-tab indicator; editor content stays intact", async ({ browser }) => {
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

      // v1.2 redesign: a note deleted in another session no longer
      // raises an in-pane "deleted-banner". The note's TAB is instead frozen
      // read-only for the session (markDeleted → deletedTabIds) and its pill
      // renders a persistent "(deleted)" indicator — role="tab" with aria-label
      // "<title> (deleted, read-only)". EditorPane suppresses the old banner
      // while isDeleted, so the tab pill is now the single source of the deleted
      // "deleted elsewhere" signal. Content is still preserved for recovery,
      // which is the core intent of this scenario.
      const deletedTabPillB = pageB.getByRole("tab", {
        name: /\(deleted, read-only\)/,
      });
      await expect(deletedTabPillB).toBeVisible({ timeout: 8_000 });
      await expect(pageB.getByText("(deleted)")).toBeVisible();

      // Primary intent: the user's unsaved work must survive the cross-session
      // delete (no data loss).
      await expect
        .poll(() => readEditorText(pageB), { timeout: 5_000 })
        .toContain(userWork);

      // The "(deleted)" indicator is persistent for the session — there
      // is no dismiss affordance to exercise. Re-assert content stays intact
      // rather than driving the removed banner-dismiss button.
      await expect(deletedTabPillB).toBeVisible();
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
      // Stop the process WITHOUT removing its data dir — jasper.kill() would
      // rm the owned dataDir, then restart() (which reuses it) would fail with
      // "--vault path does not exist". restart() does its own graceful kill of
      // the (now-dead) proc, so we only need to await exit here.
      await new Promise<void>((resolve) => {
        if (jasper.proc.exitCode !== null || jasper.proc.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          jasper.proc.kill("SIGKILL");
          resolve();
        }, 3_000);
        jasper.proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        jasper.proc.kill("SIGTERM");
      });

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
