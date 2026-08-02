/**
 * Shared deterministic tree-row-open helper.
 *
 * `toBeVisible` proves the row is painted but NOT that react-arborist has
 * rehydrated its click binding after a virtualized re-render — roughly 1 run in
 * 63, the click landed on a present-but-not-interactive row and the note never
 * opened. So each click attempt is followed by a wait on the row's own
 * data-active="true" before returning.
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
