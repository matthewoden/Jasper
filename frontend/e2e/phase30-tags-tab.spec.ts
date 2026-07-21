/**
 * Phase 30 gap closure (30-10, CR-01/TAGS-02) — right-rail Tags tab must
 * refresh on a pure tab switch between two already-open, already-mounted
 * editors, with NO intervening edit.
 *
 * Root cause this closes: useNoteTagsStore is only written from a CM6
 * docChanged transaction (handleEditorTagsChange) or on editor mount —
 * neither fires on a tab switch between two keep-alive-mounted panes. The
 * Outline panel already solved this identical problem with a
 * latestHeadingsRef + become-active flush effect; EditorPane.tsx now
 * mirrors that pattern for tags via latestTagsRef (30-10 Task 1).
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) before Playwright — the spec runs against the EMBEDDED binary.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive assertion uses
 * expect/expect.poll (memory no-flaky-tests).
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected, apiCreateNote } from "./helpers/phase7Helpers";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

function tabStrip(page: Page): Locator {
  return page.getByTestId("tab-strip");
}

/** The tab pill (role="tab") whose visible label matches `title` exactly. */
function tabPill(page: Page, title: string): Locator {
  return tabStrip(page).getByRole("tab").filter({ hasText: title });
}

function noteTagChip(page: Page, name: string): Locator {
  return page.getByTestId(`note-tag-chip-${name}`);
}

async function openNoteAsTab(
  page: Page,
  baseURL: string,
  title: string,
  tag: string,
): Promise<string> {
  const noteId = await apiCreateNote(
    page,
    baseURL,
    `${title}.md`,
    "",
    `# ${title}\n\nBody text for the Phase 30-10 tab-switch regression. #${tag}\n`,
  );
  await openNoteFromTree(page, noteId);
  return noteId;
}

test.describe("@tags-tab-switch Phase 30-10: Tags tab refreshes on tab switch without editing", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("switching between two already-open tabs (no edit) updates the Tags tab; closing the last tab clears it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    // Two notes, distinct inline tags, both opened as tabs — the second
    // open leaves the first pane hidden-but-mounted (keep-alive, D-01).
    const alphaTitle = "tags-tab-switch-alpha";
    const betaTitle = "tags-tab-switch-beta";
    await openNoteAsTab(page, jasper.baseURL, alphaTitle, "alpha");
    await openNoteAsTab(page, jasper.baseURL, betaTitle, "beta");

    const strip = tabStrip(page);
    await expect(strip.getByRole("tab")).toHaveCount(2);

    // Select the Tags right-rail tab once — it stays selected across the
    // tab switches below (TAGS-01 persists the active rail tab, not tied
    // to which note tab is active).
    const tabRow = page.getByTestId("right-rail-tab-row");
    await tabRow.getByRole("button", { name: "Tags" }).click();

    // beta is the currently active tab (just opened) — its tags should
    // already be live-parsed on mount.
    await expect(noteTagChip(page, "beta")).toBeVisible({ timeout: 5_000 });
    await expect(noteTagChip(page, "alpha")).not.toBeVisible();

    // Activate alpha via its tab pill — NO edit, NO keystroke. This is the
    // exact sequence that was previously stale: alpha's cached tags must
    // flush into the store via the become-active effect alone.
    await tabPill(page, alphaTitle).click();
    await expect(noteTagChip(page, "alpha")).toBeVisible({ timeout: 5_000 });
    await expect(noteTagChip(page, "beta")).not.toBeVisible();

    // Activate beta again — WITHOUT typing anything — and assert the
    // section flips back. Proves the flush works both directions and a
    // background pane's cache never wins over the newly active pane.
    await tabPill(page, betaTitle).click();
    await expect(noteTagChip(page, "beta")).toBeVisible({ timeout: 5_000 });
    await expect(noteTagChip(page, "alpha")).not.toBeVisible();

    // Close beta (the active tab) — Obsidian-parity close activates the
    // remaining tab (alpha), so the Tags tab should show alpha again.
    await tabPill(page, betaTitle).getByRole("button", { name: `Close ${betaTitle}` }).click();
    await expect(strip.getByRole("tab")).toHaveCount(1);
    await expect(noteTagChip(page, "alpha")).toBeVisible({ timeout: 5_000 });

    // Close the last remaining tab — the Note-tags section must return to
    // its "No note open" empty state, not keep showing alpha's stale tags.
    await tabPill(page, alphaTitle).getByRole("button", { name: `Close ${alphaTitle}` }).click();
    await expect(strip.getByRole("tab")).toHaveCount(0);
    await expect(page.getByText("No note open")).toBeVisible({ timeout: 5_000 });
    await expect(noteTagChip(page, "alpha")).not.toBeVisible();
  });
});
