/**
 * uat3-flush-race.spec.ts — real-browser reproduction of the
 * flush-on-close save-failure race).
 *
 * The common close path is: click the tab's close X while a note has
 * unsaved edits -> the click blurs the CodeMirror editor first -> blur
 * starts an in-flight save (EditorPane.performSave) -> the close handler's
 * own flush() call (App.tsx flushAndClose) lands WHILE that save is still
 * in flight and coalesces onto it (EditorPane's trailingWaiters queue).
 * Before the 18.2-01 fix, the coalescing branch optimistically resolved
 * `{ ok: true }` without waiting for the real outcome, so a failed save
 * silently closed the tab and dropped the edit. This spec proves the fix
 * ON the coalescing path specifically: the blur-started PUT is HELD in
 * flight (page.route defers settling it) until after the close click is
 * processed, so flush() is guaranteed to land while that save is still in
 * flight and coalesce onto its real outcome — an immediate abort could
 * settle first and let flush start its own save, bypassing coalescing.
 * Only then is the held PUT aborted; the "Save failed — close
 * anyway?" dialog (FlushConfirmDialog) must surface, and "Close without
 * saving" must leave zero tabs + the blank fallback pane (the
 * flush-reject close path also clears the legacy activeNoteId so the note
 * does not reappear in the tab-less fallback).
 *
 * Discipline: zero fixed sleeps; every timing-sensitive step uses a
 * web-first assertion (expect / expect.poll). Real keyboard input into
 * `.cm-content` — never `fireEvent`/DOM mutation — and a real click on the
 * tab's close X, never a synthetic blur event, so the actual browser
 * focus-then-click ordering drives the race.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

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

test.describe("@uat3 dirty-tab close-X race surfaces the flush-confirm dialog", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("held-PUT abort + real edit + real close-X click -> 'Save failed — close anyway?' -> 'Close without saving' leaves zero tabs + blank fallback", async ({
    page,
  }) => {
    const noteId = await createNote(jasper, "uat3-flush-race");
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);
    await expect(tabPills(page)).toHaveCount(1);

    await expect(page.locator(".cm-content:visible")).toBeVisible({
      timeout: 10_000,
    });

    // Hold the note's PUTs in flight (unsettled) until released, then abort.
    // Aborting immediately would leave a timing window where the
    // blur-started save settles BEFORE the close handler's flush() runs —
    // flush would then start its own failing save and the dialog would
    // surface without ever exercising the coalescing branch.
    // Holding the PUT until after the close click is processed pins the
    // interleaving: flush() must coalesce onto the in-flight save. Every
    // other request (including the initial GET) continues normally.
    let putCount = 0;
    let releaseHeldPut = (): void => {};
    const putHeld = new Promise<void>((resolve) => {
      releaseHeldPut = resolve;
    });
    await page.route("**/api/v1/notes/**", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      putCount += 1;
      await putHeld;
      return route.abort();
    });

    // Real keyboard input (not fireEvent) so this reproduces an actual
    // browser edit, marking userHasEdited so blur/flush trigger a save.
    await page.locator(".cm-content:visible").click();
    await page.keyboard.type(" — an edit that will fail to save");

    // Click the tab's close X. This blurs the editor first (starting the
    // PUT now held in flight), then flushAndClose's flush() call lands
    // while that save cannot have settled and coalesces onto its real
    // (failing) outcome — the exact race path.
    const closeBtn = tabPills(page)
      .first()
      .locator('button[aria-label^="Close "]');
    await closeBtn.click();

    // The click has been processed, so flush() has already coalesced onto
    // the held save. Confirm the held PUT reached the route, then release
    // it so the save fails and its real outcome flows to the coalesced
    // flush.
    await expect.poll(() => putCount, { timeout: 10_000 }).toBe(1);
    releaseHeldPut();

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
