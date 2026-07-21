/**
 * openNoteFromTree.ts — shared deterministic tree-row-open helper.
 *
 * Extracted from the ~15 duplicated inline copies across the phase15/18-28
 * UAT specs (closes folded todo
 * 2026-07-18-phase26-e2e-opennotefromtree-tree-row-flake.md).
 *
 * The prior inline version only waited on `toBeVisible` before clicking:
 *   async function openNoteFromTree(page, id) {
 *     const row = noteRow(page, id);
 *     await expect(row).toBeVisible({ timeout: 10_000 });
 *     await row.click();
 *   }
 * `toBeVisible` proves the row is painted, but does not prove
 * react-arborist has finished (re-)hydrating the row's click binding after
 * a virtualized re-render triggered by the just-created note's WS-driven
 * tree update — roughly 1 run in ~63 the click landed on a row that was
 * present-but-not-yet-interactive and the note never opened.
 *
 * Fixed here with a bounded, deterministic retry: after each click
 * attempt, wait for the row's own `data-active="true"` attribute (set by
 * TreeRow.tsx whenever `activeNoteId` matches the row's note id) to
 * confirm the click actually registered before returning. No
 * `page.waitForTimeout`/sleep is used as a primary wait.
 */
import { expect, type Page, type Locator } from "@playwright/test";

/** Locator for a note row in the file tree by note id. */
export function noteRow(page: Page, id: string): Locator {
  return page.locator(`[data-tree-row="${id}"][data-tree-row-kind="note"]`);
}

/**
 * Open a tree note by clicking its row.
 *
 * Waits for the row to be visible, then bounded-retries the click until
 * the row reports `data-active="true"` — proof the click was registered
 * and the note became active — rather than trusting a single click
 * immediately after a visibility check.
 *
 * @param page      - Playwright Page
 * @param id        - Note UUID
 * @param opts.timeoutMs - Overall deadline for the visibility wait AND the
 *                          click-and-confirm retry loop (default 10_000).
 */
export async function openNoteFromTree(
  page: Page,
  id: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const row = noteRow(page, id);
  await expect(row).toBeVisible({ timeout: timeoutMs });

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      await row.click({ timeout: 2_000 });
      await expect(row).toHaveAttribute("data-active", "true", { timeout: 1_000 });
      return;
    } catch (e) {
      lastError = e;
      // Row was present but the click didn't register as an activation yet
      // (virtualized re-render mid-hydration) — re-resolve and retry.
    }
  } while (Date.now() < deadline);

  throw new Error(
    `openNoteFromTree: row ${id} did not become active after click within ${timeoutMs}ms (${String(lastError)})`,
  );
}
