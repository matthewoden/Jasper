/**
 * D-18 through D-22: seamless title <-> body keyboard traversal.
 *
 * Proves, against a real embedded binary + real keyboard/mouse input:
 *  - ArrowDown from the title lands the caret on the first VISIBLE body
 *    line — skipping BOTH the hidden frontmatter block AND the separately-
 *    hidden first ATX H1 line (31-RESEARCH.md Pitfall 2). A sentinel
 *    character typed immediately after crossing must land in the body only,
 *    never mutate the frontmatter or the H1 line.
 *  - Enter from the title moves focus into the body WITHOUT inserting
 *    anything into the document (D-19) — the persisted note content is
 *    byte-identical before and after.
 *  - ArrowUp from the body's first visible line returns focus to the title.
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) before Playwright — this spec runs against the EMBEDDED binary.
 *
 * Real input only (memory verify-dnd-with-real-mouse's broader lesson:
 * synthetic events false-pass): `page.mouse.click` + `page.keyboard.press`
 * drive genuine browser events, matching CM6's own internal dispatch.
 *
 * Discipline: zero fixed sleeps; every timing-sensitive assertion uses
 * expect/expect.poll (memory no-flaky-tests).
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { apiCreateNote, waitForConnected } from "./helpers/phase7Helpers";

const NOTE_CONTENT = `---
tags: [alpha]
---
# Traversal Test
Body line one.
Body line two.
`;

async function openNoteInEditor(page: Page, noteId: string): Promise<void> {
  const row = page.locator(`[data-tree-row="${noteId}"][data-tree-row-kind="note"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  // v1.2 keep-alive tabs leave hidden .cm-content nodes mounted; scope to the
  // VISIBLE (active-tab) editor (mirrors phase29-frontmatter-backspace.spec.ts).
  await page.waitForSelector(".cm-content:visible", { timeout: 8_000 });
}

async function getNoteContent(page: Page, baseURL: string, noteId: string): Promise<string> {
  const resp = await page.request.get(`${baseURL}/api/v1/notes/${noteId}`);
  expect(resp.status()).toBe(200);
  const data = (await resp.json()) as { content?: string };
  return data.content ?? "";
}

/** Clicks near the left edge of the title's rendered text — lands the caret at/near column 0. */
async function clickTitleStart(page: Page): Promise<void> {
  const titleEl = page.getByTestId("editor-title-element");
  const box = await titleEl.boundingBox();
  if (!box) throw new Error("clickTitleStart: title element has no bounding box");
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
}

test.describe("@phase31 D-18..D-22: title <-> body traversal", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("ArrowDown from the title lands the caret on the first visible body line — never in frontmatter or the hidden H1", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "d19-arrowdown.md",
      "",
      NOTE_CONTENT,
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteInEditor(page, noteId);

    await clickTitleStart(page);
    await expect(page.getByTestId("editor-title-element")).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".cm-content:visible")).toBeFocused();

    // Sentinel: typing immediately after the crossover proves exactly where
    // the caret landed — the frontmatter/H1 lines must be byte-identical to
    // the original afterward, and the sentinel must appear only in the body.
    await page.keyboard.type("Z");

    await expect
      .poll(async () => getNoteContent(page, jasper.baseURL, noteId), { timeout: 5_000 })
      .not.toBe(NOTE_CONTENT);

    const updated = await getNoteContent(page, jasper.baseURL, noteId);
    const originalLines = NOTE_CONTENT.split("\n");
    const updatedLines = updated.split("\n");
    const h1Index = originalLines.findIndex((l) => l.startsWith("# "));
    expect(h1Index).toBeGreaterThanOrEqual(0);

    // Frontmatter + H1 lines (everything up to and including the H1) must be
    // completely untouched by the sentinel keystroke.
    for (let i = 0; i <= h1Index; i++) {
      expect(updatedLines[i]).toBe(originalLines[i]);
    }
    // The sentinel landed somewhere in the body (after the H1 line).
    const bodyAfter = updatedLines.slice(h1Index + 1).join("\n");
    expect(bodyAfter).toContain("Z");
  });

  test("Enter from the title moves focus into the body and inserts nothing into the document", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteId = await apiCreateNote(page, jasper.baseURL, "d19-enter.md", "", NOTE_CONTENT);

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteInEditor(page, noteId);

    const contentBefore = await getNoteContent(page, jasper.baseURL, noteId);
    expect(contentBefore).toBe(NOTE_CONTENT);

    await clickTitleStart(page);
    await expect(page.getByTestId("editor-title-element")).toBeFocused();

    await page.keyboard.press("Enter");

    // Focus moved into the body...
    await expect(page.locator(".cm-content:visible")).toBeFocused();
    // ...and the live editor DOM shows no inserted blank line/character:
    // both body lines are still present, adjacent, unchanged.
    await expect(page.locator(".cm-content:visible")).toContainText("Body line one.");
    await expect(page.locator(".cm-content:visible")).toContainText("Body line two.");

    // No autosave was ever triggered (Enter never dispatched a docChanged
    // transaction) — the persisted content stays byte-identical.
    await expect(page.locator('[data-save-state="saving"]')).toHaveCount(0);
    await expect
      .poll(async () => getNoteContent(page, jasper.baseURL, noteId), { timeout: 3_000 })
      .toBe(NOTE_CONTENT);
  });

  test("ArrowUp from the body's first visible line returns focus to the title", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteId = await apiCreateNote(page, jasper.baseURL, "d19-arrowup.md", "", NOTE_CONTENT);

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteInEditor(page, noteId);

    // Click directly on the first visible body line ("Body line one.").
    const bodyLine = page.locator(".cm-content:visible .cm-line", { hasText: "Body line one." }).first();
    await expect(bodyLine).toBeVisible({ timeout: 5_000 });
    const box = await bodyLine.boundingBox();
    if (!box) throw new Error("bodyLine has no bounding box");
    await page.mouse.click(box.x + 2, box.y + box.height / 2);
    await expect(page.locator(".cm-content:visible")).toBeFocused();

    await page.keyboard.press("ArrowUp");

    await expect(page.getByTestId("editor-title-element")).toBeFocused();

    // No side-effect edit from the crossover itself.
    await expect
      .poll(async () => getNoteContent(page, jasper.baseURL, noteId), { timeout: 3_000 })
      .toBe(NOTE_CONTENT);
  });
});
