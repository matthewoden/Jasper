/**
 * With YAML frontmatter hidden, Backspace at the first editable position must not
 * delete into, reveal, or corrupt the hidden block.
 *
 * page.keyboard.press drives a genuine browser keydown, matching CM6's own
 * dispatch — a synthetic event would false-pass.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { apiCreateNote, waitForConnected } from "./helpers/phase7Helpers";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

const NOTE_CONTENT = `---
tags: [alpha, beta]
---
# Body
Paragraph one.
`;

async function openNoteInEditor(page: Page, noteId: string): Promise<void> {
  const row = page.locator(`[data-tree-row="${noteId}"][data-tree-row-kind="note"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  // v1.2 keep-alive tabs leave hidden .cm-content nodes mounted; scope to the
  // VISIBLE (active-tab) editor (mirrors phase12.1-uat.spec.ts's rationale).
  await page.waitForSelector(".cm-content:visible", { timeout: 8_000 });
}

async function getNoteContent(page: Page, baseURL: string, noteId: string): Promise<string> {
  const resp = await page.request.get(`${baseURL}/api/v1/notes/${noteId}`);
  expect(resp.status()).toBe(200);
  const data = (await resp.json()) as { content?: string };
  return data.content ?? "";
}

test.describe("@phase29 frontmatter Backspace-at-top guard", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Backspace at the hidden-frontmatter boundary is a no-op: frontmatter unchanged, not revealed", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "d23backspacetop.md",
      "",
      NOTE_CONTENT,
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteInEditor(page, noteId);

    // Frontmatter starts hidden by default (frontmatterDecoField.create → hidden: true).
    // No raw "---"/"tags:" text should be visible, and no .cm-frontmatter line
    // decorations (the raw-view marker) should be present.
    const editorContent = page.locator(".cm-content:visible");
    await expect(editorContent).not.toContainText("tags: [alpha, beta]");
    await expect(page.locator(".cm-frontmatter:visible")).toHaveCount(0);

    // Focus the editor, then move the caret to the first editable position
    // (the hidden-frontmatter boundary) via Mod-Home / Mod-ArrowUp
    // (cursorDocStart in @codemirror/commands' defaultKeymap).
    await editorContent.click();
    await page.keyboard.press(`${MOD}+ArrowUp`);

    const contentBeforeBackspace = await getNoteContent(page, jasper.baseURL, noteId);
    expect(contentBeforeBackspace).toBe(NOTE_CONTENT);

    // Real key press — the repro step.
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");

    // Give any (incorrect) autosave/reindex path a moment to settle, then
    // assert the frontmatter was never touched — poll rather than a fixed
    // sleep (memory no-flaky-tests). No dirty/saving state should ever
    // appear because the guard prevents any doc-changing transaction.
    await expect(page.locator('[data-save-state="saving"]')).toHaveCount(0);

    // Frontmatter still not revealed in the DOM.
    await expect(editorContent).not.toContainText("tags: [alpha, beta]");
    await expect(page.locator(".cm-frontmatter:visible")).toHaveCount(0);

    // Body text intact — Backspace did not eat into the body either.
    await expect(editorContent).toContainText("Paragraph one.");

    // Source of truth: the note's persisted content is byte-identical.
    await expect
      .poll(async () => getNoteContent(page, jasper.baseURL, noteId), { timeout: 5_000 })
      .toBe(NOTE_CONTENT);
  });
});
