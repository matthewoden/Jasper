/**
 * uat3-flush-race.spec.ts — real-browser reproduction of UAT-3 (the
 * flush-on-close save-failure race).
 *
 * The common close path is: click the tab's close X while a note has
 * unsaved edits -> the click blurs the CodeMirror editor first -> blur
 * starts an in-flight save (EditorPane.performSave) -> the close handler's
 * own flush() call (App.tsx flushAndClose) lands WHILE that save is still
 * in flight and coalesces onto it (EditorPane's trailingWaiters queue).
 * Before the 18.2-01 fix, the coalescing branch optimistically resolved
 * `{ ok: true }` without waiting for the real outcome, so a failed save
 * silently closed the tab and dropped the edit. This spec proves the fix:
 * with the note's PUT aborted (page.route), the "Save failed — close
 * anyway?" dialog (FlushConfirmDialog) must surface on this exact path,
 * and "Close without saving" must leave zero tabs + the blank fallback
 * pane (per WR-01, the flush-reject close path also clears the legacy
 * activeNoteId so the note does not reappear in the tab-less fallback).
 *
 * Discipline: zero fixed sleeps; every timing-sensitive step uses a
 * web-first assertion (expect / expect.poll). Real keyboard input into
 * `.cm-content` — never `fireEvent`/DOM mutation — and a real click on the
 * tab's close X, never a synthetic blur event, so the actual browser
 * focus-then-click ordering drives the race.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

async function waitForConnected(page: Page, baseURL: string): Promise<void> {
  await page.goto(baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

/** Create a note via the API; returns its UUID. */
async function createNote(jasper: JasperHandle, title: string): Promise<string> {
  const resp = await fetch(`${jasper.baseURL}/api/v1/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent_path: "", title }),
  });
  if (!resp.ok) throw new Error(`create ${title}: ${resp.status}`);
  return ((await resp.json()) as { id: string }).id;
}

function tabStrip(page: Page) {
  return page.getByTestId("tab-strip");
}

function tabPills(page: Page) {
  return tabStrip(page).getByRole("tab");
}

function noteRow(page: Page, id: string) {
  return page.locator(`[data-tree-row="${id}"][data-tree-row-kind="note"]`);
}

async function openNoteFromTree(page: Page, id: string): Promise<void> {
  const row = noteRow(page, id);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
}

test.describe("@uat3 UAT-3: dirty-tab close-X race surfaces the flush-confirm dialog", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("PUT-abort + real edit + real close-X click -> 'Save failed — close anyway?' -> 'Close without saving' leaves zero tabs + blank fallback", async ({
    page,
  }) => {
    const noteId = await createNote(jasper, "uat3-flush-race");
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);
    await expect(tabPills(page)).toHaveCount(1);

    await expect(page.locator(".cm-content:visible")).toBeVisible({
      timeout: 10_000,
    });

    // Abort only the note's PUT — every other request (including the initial
    // GET that loaded the note) continues normally.
    await page.route("**/api/v1/notes/**", (route) => {
      if (route.request().method() === "PUT") return route.abort();
      return route.continue();
    });

    // Real keyboard input (not fireEvent) so this reproduces an actual
    // browser edit, marking userHasEdited so blur/flush trigger a save.
    await page.locator(".cm-content:visible").click();
    await page.keyboard.type(" — an edit that will fail to save");

    // Click the tab's close X. This blurs the editor first (starting an
    // in-flight PUT that will be aborted), then flushAndClose's flush()
    // call lands while that save is still in flight and coalesces onto its
    // real (failing) outcome — the exact UAT-3 race path.
    const closeBtn = tabPills(page)
      .first()
      .locator('button[aria-label^="Close "]');
    await closeBtn.click();

    const dialog = page.getByRole("alertdialog", {
      name: "Save failed — close anyway?",
    });
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    await dialog.getByRole("button", { name: "Close without saving" }).click();

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    await expect(tabPills(page)).toHaveCount(0, { timeout: 5_000 });

    const placeholder = page.getByTestId("editor-pane-placeholder");
    await expect(placeholder).toBeVisible({ timeout: 5_000 });
    await expect(placeholder).toHaveText("Select a note to start editing.");
  });
});
