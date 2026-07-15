/**
 * Phase 21 UAT — Reading Surface & Markdown Extras.
 *
 * READ-01: every full-pane reading surface (note body, the
 *   `editor-pane-placeholder` empty state, FilePreviewView) renders inside a
 *   760px-max, horizontally-centered, border-box column. Content wider than
 *   760px scrolls horizontally inside the column; the column's outer edges
 *   never move. The breadcrumb band stays pane-wide chrome (unaffected).
 *
 * Harness mirrors phase20-uat.spec.ts: spawnJasper() per describe block
 * against a rebuilt binary, real page interactions, @phase21 tag.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive assertion uses
 * expect/expect.poll — never page.waitForTimeout.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CENTER_TOLERANCE_PX = 4;

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

/** Set a note's body content via the API (no If-Match — force write). */
async function setNoteContent(
  jasper: JasperHandle,
  id: string,
  content: string,
): Promise<void> {
  const resp = await fetch(`${jasper.baseURL}/api/v1/notes/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) throw new Error(`set content ${id}: ${resp.status}`);
}

function noteRow(page: Page, id: string) {
  return page.locator(`[data-tree-row="${id}"][data-tree-row-kind="note"]`);
}

/** Open a tree note by clicking its row; waits for the row to be visible first. */
async function openNoteFromTree(page: Page, id: string): Promise<void> {
  const row = noteRow(page, id);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
}

test.describe("@phase21 centered-column geometry: note surface, empty state, file preview", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
    const artifactsDir = path.join(__dirname, ".artifacts");
    if (!fs.existsSync(artifactsDir)) {
      fs.mkdirSync(artifactsDir, { recursive: true });
    }
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("note body .cm-content is <=760px wide and horizontally centered at a wide viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteId = await createNote(jasper, "wide-column-note");
    await setNoteContent(
      jasper,
      noteId,
      "# wide-column-note\n\nSome body text to render the reading column.\n",
    );
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    const cmContent = page.locator(".cm-content:visible");
    const scroller = page.locator(".cm-scroller:visible").first();

    let contentBox = await cmContent.boundingBox();
    let scrollerBox = await scroller.boundingBox();
    await expect
      .poll(async () => {
        contentBox = await cmContent.boundingBox();
        scrollerBox = await scroller.boundingBox();
        return (contentBox?.width ?? 0) > 0 && (scrollerBox?.width ?? 0) > 0;
      }, { timeout: 5_000 })
      .toBe(true);
    if (!contentBox || !scrollerBox) {
      throw new Error("bounding boxes unavailable");
    }

    expect(contentBox.width).toBeLessThanOrEqual(760);

    const leftInset = contentBox.x - scrollerBox.x;
    const rightInset = (scrollerBox.x + scrollerBox.width) - (contentBox.x + contentBox.width);
    expect(Math.abs(leftInset - rightInset)).toBeLessThanOrEqual(CENTER_TOLERANCE_PX);

    // UAT evidence: wide-viewport screenshot proving the column is centered,
    // not left-hugging (RESEARCH Pitfall 1 warning-sign check).
    await page.screenshot({
      path: path.join(__dirname, ".artifacts", "phase21-centered-column.png"),
      fullPage: false,
    });
  });

  test("editor-pane-placeholder empty state renders its content within a <=760px centered wrapper", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await waitForConnected(page, jasper.baseURL);

    const placeholder = page.getByTestId("editor-pane-placeholder");
    await expect(placeholder).toBeVisible({ timeout: 10_000 });

    const wrapper = placeholder.locator("div").first();
    let wrapperBox = await wrapper.boundingBox();
    let placeholderBox = await placeholder.boundingBox();
    await expect
      .poll(async () => {
        wrapperBox = await wrapper.boundingBox();
        placeholderBox = await placeholder.boundingBox();
        return (wrapperBox?.width ?? 0) > 0 && (placeholderBox?.width ?? 0) > 0;
      }, { timeout: 5_000 })
      .toBe(true);
    if (!wrapperBox || !placeholderBox) {
      throw new Error("bounding boxes unavailable");
    }

    expect(wrapperBox.width).toBeLessThanOrEqual(760);

    const leftInset = wrapperBox.x - placeholderBox.x;
    const rightInset = (placeholderBox.x + placeholderBox.width) - (wrapperBox.x + wrapperBox.width);
    expect(Math.abs(leftInset - rightInset)).toBeLessThanOrEqual(CENTER_TOLERANCE_PX);
  });

  test("FilePreviewView content container uses the <=760px centered wrapper", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    const notesDir = path.join(jasper.dataDir, "notes");
    const galleryDir = path.join(notesDir, "gallery");
    fs.mkdirSync(galleryDir, { recursive: true });
    const attachDir = path.join(galleryDir, "attachments");
    fs.mkdirSync(attachDir, { recursive: true });
    fs.writeFileSync(path.join(attachDir, "photo.png"), Buffer.from("\x89PNG\r\n\x1a\n"));

    await createNote(jasper, "gallery-anchor-note");

    const reindexResp = await fetch(`${jasper.baseURL}/api/v1/admin/reindex`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "full" }),
    });
    expect([200, 202]).toContain(reindexResp.status);

    await waitForConnected(page, jasper.baseURL);
    await expect(page.getByTestId("reindex-progress")).toHaveCount(0, { timeout: 10_000 });
    await page.reload();
    await waitForConnected(page, jasper.baseURL);

    const galleryFolder = page.locator('[data-tree-row="gallery"][data-tree-row-kind="folder"]');
    await expect(galleryFolder).toBeVisible({ timeout: 8_000 });
    await galleryFolder.click();
    await expect(galleryFolder).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });

    const attachmentsFolder = page.locator('[data-tree-row="gallery/attachments"][data-tree-row-kind="folder"]');
    await expect(attachmentsFolder).toBeVisible({ timeout: 5_000 });
    await attachmentsFolder.click();
    await expect(attachmentsFolder).toHaveAttribute("aria-expanded", "true", { timeout: 3_000 });

    const photoRow = page.locator('[data-tree-row="gallery/attachments/photo.png"][data-tree-row-kind="file"]');
    await expect(photoRow).toBeVisible({ timeout: 5_000 });
    await photoRow.click();

    const preview = page.getByTestId("file-preview-view");
    await expect(preview).toBeVisible({ timeout: 5_000 });

    const column = preview.locator("div").first();
    let columnBox = await column.boundingBox();
    let previewBox = await preview.boundingBox();
    await expect
      .poll(async () => {
        columnBox = await column.boundingBox();
        previewBox = await preview.boundingBox();
        return (columnBox?.width ?? 0) > 0 && (previewBox?.width ?? 0) > 0;
      }, { timeout: 5_000 })
      .toBe(true);
    if (!columnBox || !previewBox) {
      throw new Error("bounding boxes unavailable");
    }

    expect(columnBox.width).toBeLessThanOrEqual(760);
  });
});


// ─── READ-02: Callouts — render, unknown fallback, auto-title, per-line ────
// reveal, and fold-click (D-05/D-06/D-07/D-08/D-09). Fold interaction is
// driven by real page.mouse (never dispatchEvent/synthetic events) per the
// verify-dnd-with-real-mouse memory; zero fixed sleeps throughout.

const CALLOUT_RGB: Record<string, string> = {
  tip: "rgb(74, 222, 128)", // --color-success #4ade80
  note: "rgb(125, 211, 252)", // --color-callout-info #7dd3fc
  info: "rgb(125, 211, 252)", // --color-callout-info #7dd3fc
  warning: "rgb(251, 191, 36)", // --color-warning #fbbf24
  danger: "rgb(248, 113, 113)", // --color-destructive #f87171
  todo: "rgb(167, 139, 250)", // --color-accent default #a78bfa
};

test.describe("@phase21 callouts", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("renders each of the six callout types with the correct colored left border", async ({
    page,
  }) => {
    const noteId = await createNote(jasper, "callout-all-types");
    await setNoteContent(
      jasper,
      noteId,
      "> [!tip] Tip title\n> body\n\n" +
        "> [!note] Note title\n\n" +
        "> [!info] Info title\n\n" +
        "> [!warning] Warning title\n\n" +
        "> [!danger] Danger title\n\n" +
        "> [!todo] Todo title\n",
    );
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    for (const type of ["tip", "note", "info", "warning", "danger", "todo"]) {
      const line = page.locator(`.cm-callout-${type}`).first();
      await expect(line).toBeVisible({ timeout: 5_000 });
      await expect
        .poll(() =>
          line.evaluate((el) => getComputedStyle(el).borderLeftColor),
        )
        .toBe(CALLOUT_RGB[type]);
    }

    await page.screenshot({
      path: path.join(__dirname, ".artifacts", "phase21-callouts-all-types.png"),
      fullPage: false,
    });
  });

  test("an unknown [!custom] type falls back to the note style with 'Custom' as the title", async ({
    page,
  }) => {
    const noteId = await createNote(jasper, "callout-unknown-type");
    await setNoteContent(jasper, noteId, "> [!custom]\n");
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    const line = page.locator(".cm-callout-note").first();
    await expect(line).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".cm-callout-title-widget")).toHaveText("Custom");
  });

  test("a bare '> [!warning]' auto-titles with the capitalized type name", async ({ page }) => {
    const noteId = await createNote(jasper, "callout-titleless");
    await setNoteContent(jasper, noteId, "> [!warning]\n");
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    const line = page.locator(".cm-callout-warning").first();
    await expect(line).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".cm-callout-title-widget")).toHaveText("Warning");
  });

  test("placing the cursor on the callout's title line reveals the raw markers while the border stays present", async ({
    page,
  }) => {
    const noteId = await createNote(jasper, "callout-cursor-reveal");
    await setNoteContent(jasper, noteId, "> [!tip] Reveal me\n\nAfter.\n");
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    // Off-cursor: the title widget renders instead of raw "[!tip]" text.
    await expect(page.locator(".cm-callout-title-widget")).toHaveText("Reveal me");

    const titleLine = page.locator(".cm-callout-title-line").first();
    await expect(titleLine).toBeVisible({ timeout: 5_000 });
    await titleLine.click();

    // On-cursor: raw markers reveal (widget disappears, raw "[!tip]" text visible).
    await expect
      .poll(async () => (await page.locator(".cm-callout-title-widget").count()) === 0)
      .toBe(true);
    await expect(titleLine).toContainText("[!tip] Reveal me");

    // The colored border stays present at all times, even while editing (D-06).
    await expect
      .poll(() => titleLine.evaluate((el) => getComputedStyle(el).borderLeftColor))
      .toBe(CALLOUT_RGB.tip);
  });

  test("a foldable '[!tip]-' callout starts collapsed and reveals its body on a real chevron click", async ({
    page,
  }) => {
    const noteId = await createNote(jasper, "callout-fold");
    await setNoteContent(
      jasper,
      noteId,
      "> [!tip]- Foldable title\n> Hidden body text\n\nAfter.\n",
    );
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    await expect(page.locator(".cm-callout-title-widget")).toHaveText("Foldable title");

    // Starts collapsed: the body line's text is not present anywhere in the editor.
    await expect(page.locator(".cm-content")).not.toContainText("Hidden body text");

    const chevron = page.locator(".cm-callout-fold-chevron").first();
    await expect(chevron).toBeVisible({ timeout: 5_000 });
    await expect(chevron).toHaveAttribute("aria-label", 'Expand "Foldable title" callout');

    const box = await chevron.boundingBox();
    if (!box) throw new Error("chevron bounding box unavailable");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    // Expanded: the body text becomes visible; aria-label flips to Collapse.
    await expect
      .poll(async () => (await page.locator(".cm-content").innerText()).includes("Hidden body text"))
      .toBe(true);
    await expect(page.locator(".cm-callout-fold-chevron").first()).toHaveAttribute(
      "aria-label",
      'Collapse "Foldable title" callout',
    );

    await page.screenshot({
      path: path.join(__dirname, ".artifacts", "phase21-callout-folded-expanded.png"),
      fullPage: false,
    });
  });
});
