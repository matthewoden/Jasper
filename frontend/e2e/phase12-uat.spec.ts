/**
 * Interactive Checkboxes.
 *
 * All synchronization uses deterministic assertion-based waits.
 *
 * Selectors:
 *   - Checkbox widget: span.cm-task-checkbox (aria-checked="true"|"false")
 *   - Checked text:    .cm-task-text-checked
 *   - Save indicator:  button[data-save-state="saved"]
 *   - Note rows:       [data-tree-row-kind="note"]
 *
 * E2E-1 (CHK-01 check):   click unchecked checkbox → file shows [x]
 * E2E-2 (CHK-01 uncheck): click checked checkbox   → file shows [ ]
 * E2E-3 (CHK-02 strike):  checked item text carries .cm-task-text-checked
 * E2E-4 (CHK-04 off-cursor): checkbox clickable when cursor is on a different line
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

let jasper: JasperHandle;

test.beforeAll(async () => {
  jasper = await spawnJasper();
});

test.afterAll(async () => {
  if (jasper) await jasper.kill();
});

/**
 * Navigate to the app and wait for the WebSocket to report "connected".
 */
async function waitForConnected(page: Page): Promise<void> {
  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

/**
 * Create a note via the API. Returns the note's UUID.
 *
 * parent_path is relative to the vault root (empty string = root).
 * Sets the note content via a subsequent PUT.
 */
async function apiCreateNote(
  page: Page,
  title: string,
  content: string,
): Promise<string> {
  const createResp = await page.request.post(`${jasper.baseURL}/api/v1/notes`, {
    data: { parent_path: "", title },
  });
  if (createResp.status() !== 201) {
    const body = await createResp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateNote: POST returned ${String(createResp.status())} for "${title}": ${body}`,
    );
  }
  const created = (await createResp.json()) as { id: string };
  const id = created.id;

  const updateResp = await page.request.put(
    `${jasper.baseURL}/api/v1/notes/${id}`,
    { data: { content } },
  );
  if (updateResp.status() !== 200) {
    const body = await updateResp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateNote: PUT returned ${String(updateResp.status())} for "${title}": ${body}`,
    );
  }
  return id;
}

/**
 * Open a note in the editor by clicking its tree row via note UUID.
 * Uses data-tree-row={noteId} which is stable and does not depend on the
 * displayed title (which may differ from the API title due to H1 extraction).
 * Waits for the CM6 editor to mount (.cm-content visible).
 */
async function openNoteInEditor(page: Page, noteId: string): Promise<void> {
  // Wait for the tree to finish loading (at least one note row visible)
  await expect(
    page.locator('[data-tree-row-kind="note"]').first(),
  ).toBeVisible({ timeout: 10_000 });

  const noteRow = page.locator(`[data-tree-row="${noteId}"][data-tree-row-kind="note"]`);
  await expect(noteRow).toBeVisible({ timeout: 8_000 });
  await noteRow.click();
  await page.waitForSelector(".cm-content", { timeout: 8_000 });
}

/**
 * Wait for the SaveIndicator to show the "saved" state.
 * The StatusBar renders a button-mode SaveIndicator with data-save-state="saved"
 * when a save completes. The button's aria-label includes "Saved at HH:MM:SS".
 * Times out after timeoutMs (default 10s) — treated as a test failure if not met.
 */
async function waitForSaved(page: Page, timeoutMs = 10_000): Promise<void> {
  await expect(
    page.locator('button[data-save-state="saved"]'),
  ).toBeVisible({ timeout: timeoutMs });
}

/**
 * Read a note's content from the API.
 */
async function getNoteContent(page: Page, noteId: string): Promise<string> {
  const resp = await page.request.get(
    `${jasper.baseURL}/api/v1/notes/${noteId}`,
  );
  expect(resp.status()).toBe(200);
  const data = (await resp.json()) as { content?: string };
  return data.content ?? "";
}

/**
 * E2E-1 (CHK-01 check): open note with "- [ ] My task"; click the unchecked
 * checkbox; wait for "Saved"; assert disk content contains "- [x] My task".
 */
test("E2E-1 CHK-01 check: unchecked checkbox click writes [x] to disk @phase12", async ({
  page,
}) => {
  const noteId = await apiCreateNote(
    page,
    "e2e-chk01-check",
    "- [ ] My task\n",
  );

  await waitForConnected(page);
  await openNoteInEditor(page, noteId);

  const checkbox = page.locator("span.cm-task-checkbox[aria-checked='false']").first();
  await expect(checkbox).toBeVisible({ timeout: 5_000 });

  await checkbox.click();

  // Wait for immediate flush to complete — save indicator shows "Saved"
  await waitForSaved(page);

  const content = await getNoteContent(page, noteId);
  expect(content).toContain("- [x] My task");
});

/**
 * E2E-2 (CHK-01 uncheck): open note with "- [x] Done task"; click the
 * checked checkbox; wait for "Saved"; assert disk content contains "- [ ] Done task".
 */
test("E2E-2 CHK-01 uncheck: checked checkbox click writes [ ] to disk @phase12", async ({
  page,
}) => {
  const noteId = await apiCreateNote(
    page,
    "e2e-chk01-uncheck",
    "- [x] Done task\n",
  );

  await waitForConnected(page);
  await openNoteInEditor(page, noteId);

  const checkbox = page.locator("span.cm-task-checkbox[aria-checked='true']").first();
  await expect(checkbox).toBeVisible({ timeout: 5_000 });

  await checkbox.click();

  await waitForSaved(page);

  const content = await getNoteContent(page, noteId);
  expect(content).toContain("- [ ] Done task");
});

/**
 * E2E-3 (CHK-02 strikethrough): open note with "- [x] Done task"; assert the
 * task text span carries .cm-task-text-checked (strikethrough class).
 */
test("E2E-3 CHK-02 strikethrough: checked item text carries .cm-task-text-checked @phase12", async ({
  page,
}) => {
  const noteId = await apiCreateNote(
    page,
    "e2e-chk02-strike",
    "- [x] Done task\n",
  );

  await waitForConnected(page);
  await openNoteInEditor(page, noteId);

  const strikeSpan = page.locator(".cm-task-text-checked").first();
  await expect(strikeSpan).toBeVisible({ timeout: 5_000 });
});

/**
 * E2E-4 (CHK-04 always-clickable): open note with two lines — a task line and
 * a regular text line. Click into the regular text line first (placing cursor
 * there). Assert the checkbox is still present in the DOM and clickable.
 * Click it; assert the disk file updated (no cursor placement required for toggle).
 */
test("E2E-4 CHK-04 off-cursor: checkbox clickable without cursor on task line @phase12", async ({
  page,
}) => {
  const noteId = await apiCreateNote(
    page,
    "e2e-chk04-offcursor",
    "- [ ] Task\n\nSome other line\n",
  );

  await waitForConnected(page);
  await openNoteInEditor(page, noteId);

  const otherLine = page
    .locator(".cm-content .cm-line")
    .filter({ hasText: /Some other line/ })
    .first();
  await expect(otherLine).toBeVisible({ timeout: 5_000 });
  await otherLine.click();

  // The checkbox widget must still be present in the DOM even though cursor is elsewhere
  const checkbox = page.locator("span.cm-task-checkbox").first();
  await expect(checkbox).toBeVisible({ timeout: 5_000 });

  // Click the checkbox — must toggle without requiring cursor placement
  await checkbox.click();

  await waitForSaved(page);

  const content = await getNoteContent(page, noteId);
  expect(content).toContain("- [x] Task");
});
