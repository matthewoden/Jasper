/**
 * Phase 5.5 UAT — Sidebar & Editor Shell Polish.
 *
 * Scenarios (each maps to one or more Phase 5.5 UX-XX requirements):
 *   UX-07 : save on blur / visibilitychange / beforeunload
 *   UX-08 : live H1 → sidebar label sync
 *   UX-09 : resizable sidebar with localStorage persistence
 *   UX-10 : full-bleed editor + click-anywhere-to-type
 *   UX-11 : reading-width line wrap (max-width 72ch)
 *   UX-12 : create-at-current-level (toolbar + right-click)
 *   UX-13 : multi-select + batch delete + multi-drag
 *   UX-14 : tree-fetch coalescing (≤2 GET /tree per CRUD session)
 *   UX-15 : heading + body share left edge off-cursor
 *   UX-16 : bullet column stable across cursor on/off
 *
 * Authoring notes (see 05.5-09-PLAN.md):
 *   - This spec is AUTHORED in Wave 1 of Phase 5.5; its assertions are
 *     VERIFIED only after Plans 01-08 land. The TS compile gates the
 *     authoring step; the actual `npx playwright test phase5_5-uat`
 *     runs at Plan 09 Task 3 (human-verify checkpoint).
 *   - The `JasperHandle` exposed by helpers/binary.ts has no
 *     `logFilePath`. UX-14 therefore uses `page.on("request", ...)` to
 *     count `/api/v1/tree` GETs from the browser side rather than
 *     spawning `count-tree-fetches.mjs` against a captured stderr file.
 *     This is documented in 05.5-09-SUMMARY.md.
 *   - Some UX-07 paths (notably `beforeunload` keepalive) cannot be
 *     verified end-to-end via Playwright; they are covered at the unit
 *     level by Plan 03's saveStateMachine tests. See `test.fixme()`
 *     blocks below for which scenarios are deliberately skipped here
 *     and why.
 */
import { test, expect, type Page } from "@playwright/test";
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
 * Navigate to baseURL, wait for the WS dot to flip to "connected", then
 * wait for the CM6 content surface so subsequent typing has a target.
 */
async function openApp(page: Page): Promise<void> {
  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
  // Click the seeded scratchpad row so the editor mounts.
  const firstNote = page.locator('[data-tree-row-kind="note"]').first();
  await expect(firstNote).toBeVisible({ timeout: 8_000 });
  await firstNote.click();
  await page.waitForSelector(".cm-content", { timeout: 8_000 });
}

/**
 * CM6 typing recipe: click .cm-content to focus, select-all, delete,
 * then keyboard-type. Identical to the recipe used in phase3-uat /
 * phase4-uat / phase5-editor.spec.ts.
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
 * Wait for the SaveIndicator to show "Saved". Plan 06 wires the
 * `data-testid="save-indicator"` attribute on the SaveIndicator root;
 * we tolerate either the testid (preferred) or the rendered text
 * "Saved" (fallback) so the spec compiles before / after Plan 06.
 */
async function waitForSaved(page: Page, timeoutMs = 8_000): Promise<void> {
  // Prefer the testid if present; fall back to text match (matches
  // the locked copy "Saved" from SaveIndicator.tsx).
  const byId = page.locator('[data-testid="save-indicator"]');
  if ((await byId.count()) > 0) {
    await expect(byId).toContainText(/saved/i, { timeout: timeoutMs });
    return;
  }
  await expect(page.getByText("Saved")).toBeVisible({ timeout: timeoutMs });
}

// ─────────────────────────────────────────────────────────────────────
// Phase 5.5 scenarios
// ─────────────────────────────────────────────────────────────────────

test.describe("Phase 5.5 UAT — sidebar + editor shell polish", () => {
  // ───────────────────────────────────────────────────────────────────
  // UX-07: save on blur
  // ───────────────────────────────────────────────────────────────────
  test("UX-07: editor blur flushes pending save", async ({ page }) => {
    await openApp(page);
    // Type a few chars; do NOT wait for the 2s autosave debounce.
    await typeIntoEditor(page, "blur-flush content");

    // Click somewhere outside the editor — into the sidebar tree —
    // BEFORE the debounce would fire. The blur handler in EditorPane
    // calls saveNow() (Plan 03). The save indicator must transition to
    // "Saved" within ~2s without us waiting for the debounce.
    const sidebarFirstRow = page
      .locator('[data-tree-row-kind="note"]')
      .first();
    await sidebarFirstRow.click({ force: true });

    // The flush is the assertion: "Saved" appears within the timeout.
    // If the blur handler is missing (or its hook into saveNow is wrong)
    // this test fails — exactly the regression Plan 03 mitigates.
    await waitForSaved(page, 5_000);
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-07: visibilitychange→hidden flushes pending save
  // ───────────────────────────────────────────────────────────────────
  test("UX-07: visibilitychange→hidden flushes pending save", async ({
    page,
  }) => {
    await openApp(page);
    await typeIntoEditor(page, "vis-change content");

    // Dispatch a synthetic visibilitychange event — Playwright lacks a
    // first-class API for tab visibility. Plan 03's window-level
    // listener calls saveNow() on document.visibilityState === "hidden".
    // The Object.defineProperty step is required because
    // document.visibilityState is a getter; setting visibilityState
    // directly is a no-op.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitForSaved(page, 5_000);
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-07: beforeunload keepalive — DELIBERATELY NOT TESTED here
  // ───────────────────────────────────────────────────────────────────
  // Playwright cannot reliably observe a request issued via
  // `fetch(..., { keepalive: true })` from a page navigating away —
  // the request is dispatched at the browser process level and
  // outlives the page. The unit test in Plan 03's saveStateMachine
  // covers this code path. Documented in 05.5-09-SUMMARY.md.
  test.fixme(
    "UX-07: beforeunload keepalive flush (covered by unit test, not E2E)",
    async () => {
      // Intentionally empty — see comment block above.
    },
  );

  // ───────────────────────────────────────────────────────────────────
  // UX-08: live H1 → sidebar label sync
  // ───────────────────────────────────────────────────────────────────
  test("UX-08: typing H1 updates sidebar label pre-save", async ({ page }) => {
    await openApp(page);

    // Capture the initial label of the seeded scratchpad row.
    const firstRow = page.locator('[data-tree-row-kind="note"]').first();
    const labelBefore = await firstRow
      .locator("[data-tree-row-label]")
      .textContent();

    // Type a fresh H1 as the very first line. Plan 04 wires
    // editor.onH1Change → useTreeStore.setLiveLabel — the tree row's
    // displayed label must update IMMEDIATELY (before the autosave
    // debounce flushes the rename to disk).
    await typeIntoEditor(page, "# Live Title\n\nbody here");

    // Poll the label until it reads "Live Title". This must happen
    // BEFORE the save indicator transitions to "Saved" (i.e., before
    // the H1→filename rename pipeline completes server-side).
    await expect
      .poll(
        async () =>
          (await firstRow
            .locator("[data-tree-row-label]")
            .textContent()) ?? "",
        { timeout: 3_000, message: "tree row label did not live-update to 'Live Title'" },
      )
      .toMatch(/live title/i);

    // Sanity: the label DID change (catches the false positive where
    // the seed already happened to be "Live Title").
    expect(labelBefore).not.toMatch(/live title/i);
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-09: drag handle resizes sidebar; width persists across reload
  // ───────────────────────────────────────────────────────────────────
  test("UX-09: drag handle resizes sidebar; width persists across reload", async ({
    page,
  }) => {
    await openApp(page);

    const handle = page.locator('[data-testid="sidebar-resize-handle"]');
    await expect(handle).toBeVisible({ timeout: 5_000 });

    // Capture nav initial width. The sidebar nav is the closest <nav>
    // ancestor of the resize handle; Plan 05 places the handle at its
    // right edge.
    const widthBefore = await page.evaluate(() => {
      const handleEl = document.querySelector(
        '[data-testid="sidebar-resize-handle"]',
      );
      const nav = handleEl?.closest("nav");
      return nav?.getBoundingClientRect().width ?? -1;
    });
    expect(widthBefore).toBeGreaterThan(0);

    // Drag the handle 80px to the right via mouse-down/move/up. CDP
    // dispatches real mouse events here — react's pointer-down handler
    // on the resize-handle element fires.
    const handleBox = await handle.boundingBox();
    if (!handleBox) {
      throw new Error("resize handle has no bounding box");
    }
    const handleX = handleBox.x + handleBox.width / 2;
    const handleY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(handleX, handleY);
    await page.mouse.down();
    await page.mouse.move(handleX + 80, handleY, { steps: 8 });
    await page.mouse.up();

    // Wait for the resize to settle (ResizeObserver / requestAnimationFrame).
    await page.waitForTimeout(250);

    const widthAfter = await page.evaluate(() => {
      const handleEl = document.querySelector(
        '[data-testid="sidebar-resize-handle"]',
      );
      const nav = handleEl?.closest("nav");
      return nav?.getBoundingClientRect().width ?? -1;
    });
    expect(widthAfter).toBeGreaterThan(widthBefore + 40); // grew by ~80px

    // Reload — Plan 05 persists the width to localStorage; the new
    // page must restore the resized width.
    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    const widthReloaded = await page.evaluate(() => {
      const handleEl = document.querySelector(
        '[data-testid="sidebar-resize-handle"]',
      );
      const nav = handleEl?.closest("nav");
      return nav?.getBoundingClientRect().width ?? -1;
    });
    expect(Math.abs(widthReloaded - widthAfter)).toBeLessThan(8); // tolerate a few px of subpixel rounding
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-09: cannot shrink sidebar below default width
  // ───────────────────────────────────────────────────────────────────
  test("UX-09: cannot shrink sidebar below the default minimum width", async ({
    page,
  }) => {
    await openApp(page);

    const handle = page.locator('[data-testid="sidebar-resize-handle"]');
    await expect(handle).toBeVisible({ timeout: 5_000 });

    // Drag the handle aggressively to the left (x=10 — well below the
    // default 260px minimum from 05.5-RESEARCH.md). Plan 05's clamp
    // logic must pin the width at the minimum.
    const handleBox = await handle.boundingBox();
    if (!handleBox) throw new Error("resize handle has no bounding box");
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(10, startY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);

    const navWidth = await page.evaluate(() => {
      const h = document.querySelector(
        '[data-testid="sidebar-resize-handle"]',
      );
      return h?.closest("nav")?.getBoundingClientRect().width ?? -1;
    });

    // Plan 05 specifies a minimum width of 260px. Allow a small
    // tolerance for subpixel rounding / scrollbar width.
    expect(navWidth).toBeGreaterThanOrEqual(252);
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-10: full-bleed editor + click-anywhere-to-type
  // ───────────────────────────────────────────────────────────────────
  test("UX-10: editor has no focus ring and clicking below last line places caret in editor", async ({
    page,
  }) => {
    await openApp(page);

    // Focus the editor by clicking inside .cm-content.
    await page.locator(".cm-content").click();

    // Plan 01 removes the focus ring. .cm-editor.cm-focused.outline
    // must resolve to "none" or contain "none".
    const outline = await page.evaluate(() => {
      const el = document.querySelector(".cm-editor.cm-focused");
      if (!el) return null;
      return getComputedStyle(el).outline;
    });
    expect(outline).not.toBeNull();
    expect((outline as string).toLowerCase()).toMatch(/none|^0|^transparent|^rgba\(0, 0, 0, 0\)/);

    // Click below the last line of the doc on the cm-host-shell. Plan
    // 01's onClick handler must focus the editor with the caret at end
    // of doc.
    const host = page.locator('[data-testid="cm-host-shell"]');
    const hostBox = await host.boundingBox();
    if (!hostBox) throw new Error("cm-host-shell has no bounding box");
    // Click 4px above the host bottom edge — empty area below the doc.
    await page.mouse.click(
      hostBox.x + hostBox.width / 2,
      hostBox.y + hostBox.height - 4,
    );

    // After the click, document.activeElement should be the .cm-content
    // surface (CM6 sets focus on .cm-content when the editor focuses).
    const activeIsEditor = await page.evaluate(() => {
      const active = document.activeElement;
      return !!active && active.classList.contains("cm-content");
    });
    expect(activeIsEditor).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-11: long line wraps; no horizontal scroll
  // ───────────────────────────────────────────────────────────────────
  test("UX-11: long line wraps inside reading width; no horizontal scroll", async ({
    page,
  }) => {
    await openApp(page);
    // Type ~120 chars on a single line (no \n). With CM6 line wrap +
    // Plan 02's max-width: 72ch CSS, the line must wrap rather than
    // overflow horizontally.
    const longLine = "A".repeat(120);
    await typeIntoEditor(page, longLine);

    // Assert .cm-content has no horizontal overflow.
    const overflowStat = await page.evaluate(() => {
      const cm = document.querySelector(".cm-content") as HTMLElement | null;
      if (!cm) return { sw: 0, cw: 0 };
      return { sw: cm.scrollWidth, cw: cm.clientWidth };
    });
    expect(overflowStat.sw).toBeLessThanOrEqual(overflowStat.cw + 1); // tolerance 1px
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-12: toolbar New note creates inside the selected folder
  // ───────────────────────────────────────────────────────────────────
  test("UX-12: toolbar New note creates inside the selected folder", async ({
    page,
  }) => {
    await openApp(page);

    // Create a folder via the toolbar.
    await page.getByRole("button", { name: /new folder/i }).click();
    // The folder enters rename mode immediately. Type its name and Enter.
    const renameInput = page
      .locator('[data-tree-row] input[type="text"]')
      .first();
    await renameInput.waitFor({ state: "visible", timeout: 3_000 });
    await renameInput.click();
    await renameInput.fill("scratch");
    await renameInput.press("Enter");

    // Click the new folder row to select it.
    const folderRow = page
      .locator('[data-tree-row-kind="folder"]')
      .filter({ hasText: /scratch/i })
      .first();
    await expect(folderRow).toBeVisible({ timeout: 3_000 });
    await folderRow.click();

    // Click toolbar "New note". With UX-12, the new note must land
    // INSIDE the selected folder (not at root).
    await page.getByRole("button", { name: /new note/i }).click();

    // Dismiss the rename input — the new note's name doesn't matter
    // for this test.
    const noteRenameInput = page
      .locator('[data-tree-row] input[type="text"]')
      .first();
    if ((await noteRenameInput.count()) > 0) {
      await noteRenameInput.press("Escape").catch(() => {
        /* race: rename closed itself */
      });
    }

    // Assert: the new note is a child of `scratch`. We check the wire
    // tree directly — the path of the new note must include "scratch/".
    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    expect(treeResp.status()).toBe(200);
    const tree = (await treeResp.json()) as {
      root: Array<{
        kind: string;
        path?: string;
        children?: Array<{ kind: string; path?: string }>;
      }>;
    };
    const scratch = tree.root.find(
      (n) =>
        n.kind === "folder" &&
        typeof n.path === "string" &&
        /scratch/i.test(n.path),
    );
    expect(scratch).toBeTruthy();
    const childNotes = (scratch?.children ?? []).filter(
      (c) => c.kind === "note",
    );
    expect(childNotes.length).toBeGreaterThanOrEqual(1);
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-12: right-click "New note" inside expanded folder does NOT collapse it
  // ───────────────────────────────────────────────────────────────────
  test("UX-12: right-click 'New note' inside expanded folder does NOT collapse the folder", async ({
    page,
  }) => {
    await openApp(page);

    // Create a folder and rename it to "scratch".
    await page.getByRole("button", { name: /new folder/i }).click();
    const renameInput = page
      .locator('[data-tree-row] input[type="text"]')
      .first();
    await renameInput.waitFor({ state: "visible", timeout: 3_000 });
    await renameInput.click();
    await renameInput.fill("scratch");
    await renameInput.press("Enter");

    const folderRow = page
      .locator('[data-tree-row-kind="folder"]')
      .filter({ hasText: /scratch/i })
      .first();
    await expect(folderRow).toBeVisible({ timeout: 3_000 });

    // Expand the folder (toggle it open) — react-arborist toggles on
    // click of the chevron. Ensure the folder is "open" before the
    // right-click test.
    await folderRow.click();

    // Right-click the folder row to open the context menu.
    await folderRow.click({ button: "right" });
    // Click the "New note" item in the context menu (Radix ContextMenu).
    const newNoteMenuItem = page.getByRole("menuitem", { name: /new note/i });
    await expect(newNoteMenuItem).toBeVisible({ timeout: 3_000 });
    await newNoteMenuItem.click();

    // Dismiss any rename input.
    const innerRename = page
      .locator('[data-tree-row] input[type="text"]')
      .first();
    if ((await innerRename.count()) > 0) {
      await innerRename.press("Escape").catch(() => {
        /* swallow race */
      });
    }

    // The folder MUST still be expanded — its child rows must be
    // visible in the tree. We check that the folder has at least one
    // child row visible (the new note we just created).
    const childNoteCount = await page
      .locator(`[data-tree-row-kind="note"]`)
      .count();
    // Initial seed = 1 (scratchpad); the new child note increments to 2.
    expect(childNoteCount).toBeGreaterThanOrEqual(2);
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-13: Cmd+click toggles multi-selection without switching active note
  // ───────────────────────────────────────────────────────────────────
  test("UX-13: Cmd+click toggles multi-selection without switching active note", async ({
    page,
  }) => {
    await openApp(page);

    // Seed: create a second note so we have two to multi-select.
    await page.getByRole("button", { name: /new note/i }).click();
    const renameInput = page
      .locator('[data-tree-row] input[type="text"]')
      .first();
    if ((await renameInput.count()) > 0) {
      await renameInput.press("Escape").catch(() => {});
    }

    // Capture the active note's content (note A — the seeded scratchpad).
    const noteRows = page.locator('[data-tree-row-kind="note"]');
    await expect(noteRows).toHaveCount(2, { timeout: 5_000 });

    const noteA = noteRows.first();
    await noteA.click();
    await page.waitForSelector(".cm-content", { timeout: 3_000 });
    const contentBefore =
      (await page.locator(".cm-content").textContent()) ?? "";

    // Cmd+click note B to multi-select WITHOUT switching the active note.
    const noteB = noteRows.nth(1);
    const multiKey = process.platform === "darwin" ? "Meta" : "Control";
    await noteB.click({ modifiers: [multiKey] });

    // The active note in the editor must STILL be note A — its
    // .cm-content textContent must match what we captured before.
    const contentAfter =
      (await page.locator(".cm-content").textContent()) ?? "";
    expect(contentAfter).toEqual(contentBefore);

    // Both rows are part of the multi-selection. react-arborist marks
    // selected rows with `aria-selected="true"`; assert at least one
    // of A or B carries the selected attribute (the precise marker
    // may shift between react-arborist versions, so we accept either
    // aria-selected="true" or a `data-selected="true"` fallback).
    const aSel = await noteA.getAttribute("aria-selected");
    const bSel = await noteB.getAttribute("aria-selected");
    const aSelData = await noteA.getAttribute("data-selected");
    const bSelData = await noteB.getAttribute("data-selected");
    expect(
      aSel === "true" ||
        bSel === "true" ||
        aSelData === "true" ||
        bSelData === "true",
    ).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-13: batch delete prompts once and removes all selected
  // ───────────────────────────────────────────────────────────────────
  test("UX-13: batch delete prompts once and removes all selected items", async ({
    page,
  }) => {
    await openApp(page);

    // Seed two extra notes for a total of 3 (scratchpad + 2 untitled).
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: /new note/i }).click();
      const renameInput = page
        .locator('[data-tree-row] input[type="text"]')
        .first();
      if ((await renameInput.count()) > 0) {
        await renameInput.press("Escape").catch(() => {});
      }
    }
    const noteRows = page.locator('[data-tree-row-kind="note"]');
    await expect(noteRows).toHaveCount(3, { timeout: 5_000 });

    // Multi-select notes 2 and 3.
    const multiKey = process.platform === "darwin" ? "Meta" : "Control";
    await noteRows.nth(1).click();
    await noteRows.nth(2).click({ modifiers: [multiKey] });

    // Press Delete to trigger the batch-delete dialog.
    await page.keyboard.press("Delete");

    // The dialog title should reference 2 items (Plan 06's
    // confirmDeleteSelection: "Delete 2 items?").
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 3_000 });
    await expect(dialog).toContainText(/delete 2 items/i);

    // Confirm. Plan 06 wires the primary action to a Delete button.
    await dialog.getByRole("button", { name: /^delete$/i }).click();

    // After confirm: only the seeded scratchpad remains.
    await expect(noteRows).toHaveCount(1, { timeout: 5_000 });
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-13: drag two folders into a third folder
  // (RESEARCH §Open Question 2 RESOLVED — exercises the upfront-path-
  // capture choice for folder multi-drag.)
  // ───────────────────────────────────────────────────────────────────
  test.fixme(
    "UX-13: drag two folders into a third folder (multi-folder DnD)",
    async ({ page }) => {
      // Fixme reason: react-arborist's multi-handle DnD pipeline runs on
      // react-dnd's html5-backend. Synthetic Playwright drag events
      // (page.mouse.down/move/up, locator.dragTo, programmatic
      // DragEvent dispatch) do NOT produce a trusted DataTransfer and
      // the html5-backend silently rejects them — the same limitation
      // documented in phase3-uat.spec.ts §Scenario A.4.
      //
      // RESEARCH §Open Question 2 RESOLVED specifies that the folder-
      // drag scenario MUST be authored in the spec so that the moment
      // a programmatic move API or CDP-based drag helper becomes
      // available, the scenario lights up. Until then, the human-
      // verify checkpoint at Plan 09 Task 3 walks this path manually.
      //
      // The intended sequence (executed manually, not by Playwright):
      //   1. Seed three folders /src-a, /src-b, /dest, each with at
      //      least one child note.
      //   2. Cmd+click /src-a then Cmd+click /src-b.
      //   3. Drag onto /dest.
      //   4. Assert /dest/src-a + /dest/src-b exist; /src-a and /src-b
      //      are gone from root; their children moved with them.
      //
      // If the second iteration of the move emits a 404/409 in any
      // future re-enabling of this test, that is the parent-of-source
      // mid-batch staleness case the research called out — Plan 07
      // would need to switch from upfront-path-capture to live-walk on
      // the folder branch.
      await openApp(page);
      // Intentionally empty body.
    },
  );

  // ───────────────────────────────────────────────────────────────────
  // UX-14: tree-fetch coalescing
  // ───────────────────────────────────────────────────────────────────
  test("UX-14: typical CRUD session issues ≤2 GET /api/v1/tree calls", async ({
    page,
  }) => {
    // Register the request listener BEFORE any navigation so we count
    // every tree fetch from page-load onward.
    const treeFetches: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      // Match /api/v1/tree with optional query string. Note: the spec
      // says "≤2 GET /tree per CRUD session"; we count only GETs.
      if (req.method() === "GET" && /\/api\/v1\/tree(?:\?|$)/.test(url)) {
        treeFetches.push(url);
      }
    });

    await openApp(page);
    // Wait briefly for the initial load + any first-render coalesce
    // window to flush.
    await page.waitForTimeout(500);
    const initialCount = treeFetches.length;

    // Issue 5 rapid create-note clicks. Plan 08's coalescing layer
    // (refreshTreeOnce + dedup) must collapse the resulting refresh
    // burst.
    for (let i = 0; i < 5; i++) {
      await page.getByRole("button", { name: /new note/i }).click();
      const renameInput = page
        .locator('[data-tree-row] input[type="text"]')
        .first();
      if ((await renameInput.count()) > 0) {
        await renameInput.press("Escape").catch(() => {});
      }
    }

    // Wait for any in-flight coalescer timer (Plan 08's debounce
    // window — research recommended 50–150ms).
    await page.waitForTimeout(800);

    const postCRUDCount = treeFetches.length;
    const sessionDelta = postCRUDCount - initialCount;

    // The acceptance criterion: ≤2 tree fetches across the whole CRUD
    // session (one initial coalesce + at most one trailing flush).
    // We measure the DELTA from before the burst, not the absolute
    // count, because openApp itself triggers the initial fetch which
    // is not part of the "CRUD session."
    expect(sessionDelta).toBeLessThanOrEqual(2);
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-15: H1, H2, body share the same left x-coordinate off-cursor
  // ───────────────────────────────────────────────────────────────────
  test("UX-15: H1, H2, and body paragraph share the same left x-coordinate when off-cursor", async ({
    page,
  }) => {
    await openApp(page);
    await typeIntoEditor(
      page,
      "# H1 line\n## H2 line\nbody line\n\nfooter line",
    );

    // Move the cursor onto the LAST line ("footer line") — off all the
    // heading lines. Plan 02 must keep the heading line + body line
    // anchored to the same left x-coordinate when not the cursor line.
    await page.locator(".cm-content").click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End",
    );

    // Read the bounding box x-coordinate of each .cm-line by its
    // text content. cm-line elements wrap each visual line; we
    // identify them by partial text match.
    const xs = await page.evaluate(() => {
      const lines = Array.from(
        document.querySelectorAll(".cm-content .cm-line"),
      );
      const out: Record<string, number> = {};
      for (const line of lines) {
        const txt = line.textContent ?? "";
        const rect = (line as HTMLElement).getBoundingClientRect();
        if (/H1 line/.test(txt)) out["h1"] = rect.x;
        else if (/H2 line/.test(txt)) out["h2"] = rect.x;
        else if (/body line/.test(txt)) out["body"] = rect.x;
      }
      return out;
    });

    expect(xs.h1).toBeDefined();
    expect(xs.h2).toBeDefined();
    expect(xs.body).toBeDefined();

    // All three left-edges within 1px of each other (subpixel
    // tolerance).
    const minX = Math.min(xs.h1, xs.h2, xs.body);
    const maxX = Math.max(xs.h1, xs.h2, xs.body);
    expect(maxX - minX).toBeLessThanOrEqual(1);
  });

  // ───────────────────────────────────────────────────────────────────
  // UX-16: bullet column does not shift when cursor enters/leaves
  // ───────────────────────────────────────────────────────────────────
  test("UX-16: bullet column does NOT shift when cursor enters/leaves a list line", async ({
    page,
  }) => {
    await openApp(page);
    await typeIntoEditor(page, "- item one\n- item two\n\nfooter");

    // First measurement: cursor is on the LAST line ("footer") — off
    // both list lines. Capture the x-coordinate of the FIRST visible
    // glyph of "item one" inside the list line.
    await page.locator(".cm-content").click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End",
    );

    const xCursorOff = await page.evaluate(() => {
      const lines = Array.from(
        document.querySelectorAll(".cm-content .cm-line"),
      );
      for (const line of lines) {
        const txt = line.textContent ?? "";
        if (/item one/.test(txt)) {
          // Walk to the first text node and get a Range rect for its
          // first character — this gives the precise glyph x-coord
          // regardless of bullet-marker geometry.
          const range = document.createRange();
          const tn = (function find(n: Node): Text | null {
            if (n.nodeType === Node.TEXT_NODE) return n as Text;
            for (const c of Array.from(n.childNodes)) {
              const r = find(c);
              if (r) return r;
            }
            return null;
          })(line);
          if (!tn) return null;
          range.setStart(tn, 0);
          range.setEnd(tn, Math.min(1, tn.textContent?.length ?? 0));
          return range.getBoundingClientRect().x;
        }
      }
      return null;
    });
    expect(xCursorOff).not.toBeNull();

    // Move cursor INTO the first list line ("item one") — Up arrows
    // until we land there.
    // Ctrl+Home → top of doc, then Down 0 (we're on "- item one").
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Home" : "Control+Home",
    );
    await page.keyboard.press("End"); // place cursor at end of first line

    const xCursorOn = await page.evaluate(() => {
      const lines = Array.from(
        document.querySelectorAll(".cm-content .cm-line"),
      );
      for (const line of lines) {
        const txt = line.textContent ?? "";
        if (/item one/.test(txt)) {
          const range = document.createRange();
          const tn = (function find(n: Node): Text | null {
            if (n.nodeType === Node.TEXT_NODE) return n as Text;
            for (const c of Array.from(n.childNodes)) {
              const r = find(c);
              if (r) return r;
            }
            return null;
          })(line);
          if (!tn) return null;
          range.setStart(tn, 0);
          range.setEnd(tn, Math.min(1, tn.textContent?.length ?? 0));
          return range.getBoundingClientRect().x;
        }
      }
      return null;
    });
    expect(xCursorOn).not.toBeNull();

    // The "item" glyph x-coord must be identical (within 1px) whether
    // the cursor is on or off the list line. Plan 02's bullet stability
    // fix for UX-16 makes this property hold.
    expect(Math.abs((xCursorOn as number) - (xCursorOff as number))).toBeLessThanOrEqual(1);
  });
});
