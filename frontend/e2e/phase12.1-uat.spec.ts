/**
 * Phase 12.1 UAT — Checkbox Editing UAT Fixes.
 *
 * RED-first test scaffolding: these tests encode the target post-fix behavior
 * for requirements U1-U7 + W1. They are EXPECTED TO FAIL until plans 02/03 land.
 * Exception: W1 documents a working case and should stay green through implementation.
 *
 * Run a single tagged test: npx playwright test e2e/phase12.1-uat.spec.ts -g "U3"
 *
 * U1 — visual: checkbox widget matches 12-UI-SPEC.md styling (screenshot; human review)
 * U2 — reveal: caret onto task line shows raw '- [ ] ' text, no widget
 * U3 — Enter on empty '- [ ] ' exits the list (marker removed, line NOT deleted)
 * U4 — Enter behavior is position-independent (same result after caret leave+return)
 * U5 — Enter on non-empty task → exactly one new '- [ ] ' line, no double-newline
 * U6 — Tab indents; Shift-Tab de-indents; focus stays in editor (not on widget)
 * U7 — off-cursor task shows checkbox widget only, no raw '-' dash beside it
 * W1 — regression: indented task Enter still creates one checkbox at correct indent
 *
 * Selectors (after plan 02 ships):
 *   - Editor content: .cm-content
 *   - Checkbox widget: button.cm-task-checkbox
 *   - Save indicator: button[data-save-state="saved"]
 *   - Note rows: [data-tree-row-kind="note"]
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let jasper: JasperHandle;

test.beforeAll(async () => {
  jasper = await spawnJasper();
  // Ensure the screenshot artifacts directory exists
  const artifactsDir = path.join(__dirname, ".artifacts");
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }
});

test.afterAll(async () => {
  if (jasper) await jasper.kill();
});

async function waitForConnected(page: Page): Promise<void> {
  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

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

async function openNoteInEditor(page: Page, noteId: string): Promise<void> {
  await expect(
    page.locator('[data-tree-row-kind="note"]').first(),
  ).toBeVisible({ timeout: 10_000 });

  const noteRow = page.locator(`[data-tree-row="${noteId}"][data-tree-row-kind="note"]`);
  await expect(noteRow).toBeVisible({ timeout: 8_000 });
  await noteRow.click();
  await page.waitForSelector(".cm-content", { timeout: 8_000 });
}

async function waitForSaved(page: Page, timeoutMs = 10_000): Promise<void> {
  await expect(
    page.locator('button[data-save-state="saved"]'),
  ).toBeVisible({ timeout: timeoutMs });
}

async function getNoteContent(page: Page, noteId: string): Promise<string> {
  const resp = await page.request.get(
    `${jasper.baseURL}/api/v1/notes/${noteId}`,
  );
  expect(resp.status()).toBe(200);
  const data = (await resp.json()) as { content?: string };
  return data.content ?? "";
}

/**
 * U1-visual: checkbox widget matches 12-UI-SPEC.md styling.
 * Automated assertion: screenshot file is written to e2e/.artifacts/.
 * Visual judgment is the human checkpoint in plan 03.
 */
test("U1-visual: checkbox widget matches UI-SPEC styling @phase12.1", async ({ page }) => {
  const noteId = await apiCreateNote(
    page,
    "u1-visual-styling",
    "- [ ] Unchecked\n- [x] Checked\n",
  );
  await waitForConnected(page);
  await openNoteInEditor(page, noteId);

  // Move caret to a non-task line (end of doc) so task lines are rendered off-cursor
  // and the checkbox widgets are visible rather than raw text
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");

  const screenshotPath = path.join(__dirname, ".artifacts", "u1-checkbox-visual.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  // Automated assertion: file was written
  expect(fs.existsSync(screenshotPath)).toBe(true);
});

/**
 * U2-reveal: caret placed on a task line reveals the raw '- [ ] ' text.
 * After D-01: when cursor is on the task line, no checkbox widget is in the DOM;
 * the raw marker text '[ ]' is present and editable in that cm-line.
 */
test("U2-reveal: arrow onto task line shows raw markup, no widget @phase12.1", async ({ page }) => {
  const noteId = await apiCreateNote(
    page,
    "u2-reveal",
    "- [ ] Task line\nAnother line\n",
  );
  await waitForConnected(page);
  await openNoteInEditor(page, noteId);

  // Click into the second line first so task line is off-cursor (widget rendered)
  const otherLine = page
    .locator(".cm-content .cm-line")
    .filter({ hasText: /Another line/ })
    .first();
  await expect(otherLine).toBeVisible({ timeout: 5_000 });
  await otherLine.click();

  // Widget should be present while cursor is off the task line
  const checkbox = page.locator("button.cm-task-checkbox").first();
  await expect(checkbox).toBeVisible({ timeout: 5_000 });

  // Now move cursor to the task line by pressing ArrowUp
  await page.keyboard.press("ArrowUp");
  // Arrow left several times to move into the [ ] marker area
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");

  // After D-01: the checkbox widget should be GONE from the DOM on the active line
  await expect(page.locator("button.cm-task-checkbox")).toHaveCount(0, { timeout: 3_000 });

  // The raw '[ ]' text must be visible/editable in the task line
  const taskLine = page.locator(".cm-content .cm-line").first();
  await expect(taskLine).toContainText("[ ]", { timeout: 3_000 });
});

/**
 * U3-enter-empty: pressing Enter on an empty '- [ ] ' task exits the list.
 * Expected: marker is removed; line is NOT deleted; editor has remaining content.
 */
test("U3-enter-empty: Enter on empty task marker exits list without deleting line @phase12.1", async ({ page }) => {
  const noteId = await apiCreateNote(
    page,
    "u3-enter-empty",
    "Some content\n",
  );
  await waitForConnected(page);
  await openNoteInEditor(page, noteId);

  // Click into the editor and navigate to the end
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");

  // Type '- [ ] ' to create an empty task marker
  await page.keyboard.type("- [ ] ");

  // Press Enter — should exit the list (remove '- [ ] ' prefix, leave empty line)
  await page.keyboard.press("Enter");

  await waitForSaved(page);

  const content = await getNoteContent(page, noteId);

  // The line must NOT be deleted — the note still has content
  expect(content.length).toBeGreaterThan(0);
  // '- [ ] ' marker should not appear in the saved content (exited the list)
  // (the empty task marker gets removed when Enter is pressed on an empty task)
  expect(content).not.toMatch(/^- \[ \] $/m);
});

/**
 * U4-enter-position-independent: Enter behavior is the same regardless of
 * whether caret moved away and returned before pressing Enter.
 */
test("U4-enter-position-independent: Enter on empty task same after caret leave+return @phase12.1", async ({ page }) => {
  const noteId = await apiCreateNote(
    page,
    "u4-enter-position-independent",
    "Some content\n",
  );
  await waitForConnected(page);
  await openNoteInEditor(page, noteId);

  // Navigate to end and type an empty task marker
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("- [ ] ");

  // Move caret UP to another line, then back DOWN to the task line.
  // (ArrowDown has no effect when on the last line, so we go Up first then Down.)
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");

  // Press Enter — must behave the same as U3 (exit list, not delete line, not move line)
  await page.keyboard.press("Enter");

  await waitForSaved(page);

  const content = await getNoteContent(page, noteId);

  // Note must still have content (line not deleted)
  expect(content.length).toBeGreaterThan(0);
  // '- [ ] ' standalone empty marker should not persist
  expect(content).not.toMatch(/^- \[ \] $/m);
});

/**
 * U5-enter-nonEmpty: Enter on a non-empty task creates exactly ONE new '- [ ] ' line.
 * No double-newline, no duplicate checkbox marker.
 */
test("U5-enter-nonEmpty: Enter on non-empty task creates exactly one new checkbox @phase12.1", async ({ page }) => {
  const noteId = await apiCreateNote(
    page,
    "u5-enter-nonempty",
    "Some content\n",
  );
  await waitForConnected(page);
  await openNoteInEditor(page, noteId);

  // Navigate to end and type a non-empty task
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("- [ ] this is a test");

  // Move caret UP to the previous line, then back DOWN to the task line.
  // (ArrowDown has no effect when on the last line, so we go Up first then Down.)
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");

  // Press Enter — must add exactly ONE new '- [ ] ' line
  await page.keyboard.press("Enter");

  await waitForSaved(page);

  const content = await getNoteContent(page, noteId);

  // Count occurrences of '- [ ] ' — should be exactly 2 (the typed one + the new continuation)
  const taskMarkerCount = (content.match(/^- \[ \] /gm) ?? []).length;
  expect(taskMarkerCount).toBe(2);

  // No double-newlines adjacent to each other
  expect(content).not.toContain("\n\n\n");
});

/**
 * U6-tab-indent: Tab indents the list item; Shift-Tab de-indents.
 * DOM focus must stay in the editor (.cm-content), not jump to the checkbox widget.
 */
test("U6-tab-indent: Tab indents task line; Shift-Tab de-indents; focus stays in editor @phase12.1", async ({ page }) => {
  const noteId = await apiCreateNote(
    page,
    "u6-tab-indent",
    "- [ ] Task to indent\n",
  );
  await waitForConnected(page);
  await openNoteInEditor(page, noteId);

  // Place cursor on the task line
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");

  // Press Tab — should indent (not focus the checkbox widget)
  await page.keyboard.press("Tab");

  // Focus must remain in .cm-content (not on the checkbox button)
  const focusedElement = await page.evaluate(() => document.activeElement?.className ?? "");
  expect(focusedElement).toContain("cm-content");

  // The line should now have leading whitespace (indented)
  await waitForSaved(page);
  const contentAfterTab = await getNoteContent(page, noteId);
  // Indented task line starts with whitespace before '- [ ] '
  expect(contentAfterTab).toMatch(/^\s+- \[ \] /m);

  // Shift-Tab should de-indent back to original level
  await page.keyboard.press("Shift+Tab");
  await waitForSaved(page);
  const contentAfterShiftTab = await getNoteContent(page, noteId);
  // Task line should be back at column 0
  expect(contentAfterShiftTab).toMatch(/^- \[ \] /m);
});

/**
 * U7-no-leaking-dash: off-cursor task line shows only the checkbox widget,
 * no raw '-' dash text beside it.
 */
test("U7-no-leaking-dash: off-cursor task shows widget only, no raw dash @phase12.1", async ({ page }) => {
  const noteId = await apiCreateNote(
    page,
    "u7-no-leaking-dash",
    "- [ ] Unchecked task\n- [x] Checked task\nSome other line\n",
  );
  await waitForConnected(page);
  await openNoteInEditor(page, noteId);

  // Click the third line so task lines are off-cursor (widgets rendered)
  const otherLine = page
    .locator(".cm-content .cm-line")
    .filter({ hasText: /Some other line/ })
    .first();
  await expect(otherLine).toBeVisible({ timeout: 5_000 });
  await otherLine.click();

  // Checkbox widgets should be visible
  const checkboxes = page.locator("button.cm-task-checkbox");
  await expect(checkboxes.first()).toBeVisible({ timeout: 5_000 });

  // The task lines in the DOM should NOT contain a raw '-' text node
  // beside the checkbox button. The checkbox replaces the full '- [ ] ' prefix.
  // Inspect the first task cm-line: it should not have '-' as a standalone text
  // beside the checkbox widget.
  const taskLineHasDash = await page.evaluate(() => {
    const lines = document.querySelectorAll(".cm-content .cm-line");
    for (const line of lines) {
      // Check if the line contains a checkbox widget
      const hasWidget = line.querySelector("button.cm-task-checkbox") !== null;
      if (!hasWidget) continue;
      // Look for a text node that is just a dash (would indicate D-02 is not implemented)
      for (const node of line.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim() === "-") {
          return true;
        }
      }
    }
    return false;
  });
  expect(taskLineHasDash).toBe(false);
});

/**
 * W1-regression: indented task line + Enter creates one new checkbox at same indent.
 * This is the documented working case from the UAT session — must not regress.
 */
test("W1-regression: indented task Enter creates one checkbox at correct indent @phase12.1", async ({ page }) => {
  const noteId = await apiCreateNote(
    page,
    "w1-regression",
    "- [ ] Parent task\n  - [ ] this is a test\n",
  );
  await waitForConnected(page);
  await openNoteInEditor(page, noteId);

  // Place cursor at the end of the indented task line '  - [ ] this is a test'.
  // Control+End lands on the empty trailing line (after the trailing \n), so we
  // press ArrowUp to move to line 2 (the indented task), then End to reach its end.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");

  // Press Enter — should create exactly one new '  - [ ] ' at the same indent
  await page.keyboard.press("Enter");

  await waitForSaved(page);

  const content = await getNoteContent(page, noteId);

  // Count indented task markers '  - [ ] ' — should be exactly 2
  const indentedMarkerCount = (content.match(/^ {2}- \[ \] /gm) ?? []).length;
  expect(indentedMarkerCount).toBe(2);

  // No double-newlines in the indented area
  expect(content).not.toContain("\n\n\n");
});
