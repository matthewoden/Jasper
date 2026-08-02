/**
 * Seamless title <-> body keyboard traversal.
 *
 * Proves, against a real embedded binary + real keyboard/mouse input:
 *  - ArrowDown from the title lands the caret on the first VISIBLE body
 *    line — skipping BOTH the hidden frontmatter block AND the separately-
 *    hidden first ATX H1 line. A sentinel
 *    character typed immediately after crossing must land in the body only,
 *    never mutate the frontmatter or the H1 line.
 *  - Enter from the title moves focus into the body WITHOUT inserting
 *    anything into the document — the persisted note content is
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

// UAT round-2 regression repro shape: H1 directly after the
// frontmatter's closing "---" (no blank line — failure mode 2), followed by
// a BLANK line before the first real paragraph (failure mode 1 — also the
// exact default new-note scaffold shape, backend/internal/markdown/newnote.go's
// "---\ntags: []\n---\n\n# {title}\n\n"). The earlier NOTE_CONTENT above has
// NO blank line after the H1 either, which happened to sidestep BOTH
// failure modes: (1) a bare `Decoration.replace` (no widget) over just the
// H1 node's own range left a normal-height, fully clickable/caret-accessible
// phantom empty row in its place whenever a blank line followed the H1 —
// indistinguishable from the genuine blank line, so a click "at the top of
// the body" could land on the WRONG (hidden H1's) line; (2) a
// `Decoration.line` display:none approach fixed (1) but silently failed to
// apply when the H1's hidden range started EXACTLY where the frontmatter's
// own hidden range ended (no blank line between them). Either way, ArrowUp's
// `curLine.number !== target.number` guard then silently no-opped (root
// cause; see firstH1HidePlugin.ts).
const NOTE_CONTENT_BLANK_AFTER_H1 = `---
tags: [alpha]
---
# Traversal Test

Some real paragraph here.
`;

// A title long enough to wrap the H1 across multiple
// visual rows at 33px/700 (pre-wrap) inside the ~648px title column
// (760px max-width - 2*56px padding), and a first body line long enough to
// wrap across multiple visual rows at the 15px/1.45 body font inside the
// same column width.
const WRAPPED_TITLE =
  "This Is A Really Quite Long Traversal Test Title That Should Wrap Across At Least Two Visual Rows In The Editor Column";
const WRAPPED_BODY_LINE =
  "This is a really long first line of body content that should wrap across at least two visual rows so the ArrowUp visual-row gating can be proven against real browser layout, not just a unit-test mock.";

const WRAPPED_NOTE_CONTENT = `---
tags: [alpha]
---
# ${WRAPPED_TITLE}
${WRAPPED_BODY_LINE}
Body line two.
`;

// round 3 — owner gesture repro shapes (#1): the user CLICKS in
// the visual empty gap between the title and the first body text (not
// typing, not arrow-navigating), landing the caret at the top of the body,
// then presses ArrowUp expecting the title to focus. Three doc shapes, since
// the earlier click-ON-the-line E2E cases above did not reproduce this.
// (a) H1 + blank line + body, NO frontmatter (common shape without a YAML
//     block at all).
const NOTE_NO_FRONTMATTER_BLANK_AFTER_H1 = `# Gap Test A

Body paragraph A.
`;
// (b) H1 immediately followed by body, no blank line, NO frontmatter.
const NOTE_NO_FRONTMATTER_NO_BLANK = `# Gap Test B
Body paragraph B.
`;
// (c) frontmatter + H1 + blank line + body (the full scaffold shape,
// byte-identical in structure to NOTE_CONTENT_BLANK_AFTER_H1 above — kept as
// its own named constant here so the three round-3 cases read as a self-
// contained group).
const NOTE_FRONTMATTER_BLANK_AFTER_H1 = `---
tags: [alpha]
---
# Gap Test C

Body paragraph C.
`;

/**
 * Clicks in the visual empty gap between the title element and the first
 * rendered `.cm-line` — the vertical midpoint of the space between the
 * title's own bottom edge and the first body line's top edge. This is
 * DISTINCT from clicking directly ON the first `.cm-line` (already covered
 * by the round-2 regression tests above): the gap is `.cm-content`'s own
 * padding-top (40px, themeBridge.ts) plus the title wrapper's paddingBottom
 * (6px, EditorPane.tsx) — real rendered space with no `.cm-line` of its own,
 * which is exactly the area the owner describes clicking into.
 */
async function clickGapAboveFirstBodyLine(page: Page): Promise<void> {
  const titleBox = await page.getByTestId("editor-title-element").boundingBox();
  const firstLine = page.locator(".cm-content:visible .cm-line").first();
  await expect(firstLine).toBeVisible({ timeout: 5_000 });
  const lineBox = await firstLine.boundingBox();
  if (!titleBox || !lineBox) {
    throw new Error("clickGapAboveFirstBodyLine: missing title or first-line bounding box");
  }
  const gapTop = titleBox.y + titleBox.height;
  const gapBottom = lineBox.y;
  if (gapBottom <= gapTop) {
    throw new Error("clickGapAboveFirstBodyLine: no measurable gap between title and body");
  }
  const gapY = (gapTop + gapBottom) / 2;
  await page.mouse.click(lineBox.x + 20, gapY);
}

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

interface RowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Returns one rect PER WRAPPED VISUAL ROW of an element's text content, via
 * Range.getClientRects() over the element's full contents — the standard
 * technique for enumerating a wrapped block's individual visual lines
 * (distinct from the element's own single bounding box, which spans all
 * rows). Used by both the title (contentEditable div) and the body
 * (`.cm-line`, a single DOM element CM6 also wraps visually via CSS) so
 * ArrowDown/ArrowUp visual-row tests can click a SPECIFIC row deterministically
 * instead of guessing a fraction of the element's overall bounding box (which
 * risks landing on a padding/margin boundary between adjacent logical lines).
 */
async function getVisualRowRects(locator: ReturnType<Page["locator"]>): Promise<RowRect[]> {
  return locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return Array.from(range.getClientRects()).map((r) => ({
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
    }));
  });
}

/** Clicks the FIRST or LAST wrapped visual row of the title element. */
async function clickTitleRow(page: Page, which: "first" | "last"): Promise<void> {
  const titleEl = page.getByTestId("editor-title-element");
  const rows = await getVisualRowRects(titleEl);
  if (rows.length === 0) throw new Error("clickTitleRow: no visual rows measured");
  const row = which === "first" ? rows[0] : rows[rows.length - 1];
  await page.mouse.click(row.x + 4, row.y + row.height / 2);
}

/** Clicks the FIRST or LAST wrapped visual row of a `.cm-line` (matched by
 *  contained text) — a single logical body line wrapped across multiple
 *  visual rows. */
async function clickBodyLineRow(page: Page, lineText: string, which: "first" | "last"): Promise<void> {
  const lineLocator = page.locator(".cm-content:visible .cm-line", { hasText: lineText }).first();
  await expect(lineLocator).toBeVisible({ timeout: 5_000 });
  const rows = await getVisualRowRects(lineLocator);
  if (rows.length === 0) throw new Error("clickBodyLineRow: no visual rows measured");
  const row = which === "first" ? rows[0] : rows[rows.length - 1];
  await page.mouse.click(row.x + 2, row.y + row.height / 2);
}

/** Reads the current collapsed caret's own on-screen rect via the live
 *  Selection API (reflects CM6's rendered cursor accurately while the body
 *  has focus) — used to prove real vertical motion happened WITHIN the
 *  body, independent of which element currently holds DOM focus. */
async function getCaretRect(page: Page): Promise<{ top: number; left: number } | null> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
    return rect ? { top: rect.top, left: rect.left } : null;
  });
}

test.describe("@phase31 title <-> body traversal", () => {
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

  test("ArrowDown from a non-last title visual row stays in the title; from the last row crosses to the body", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "cr01-title-wrap.md",
      "",
      WRAPPED_NOTE_CONTENT,
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteInEditor(page, noteId);

    const titleEl = page.getByTestId("editor-title-element");
    // Sanity: the title must actually wrap to >=2 visual rows for this test
    // to prove anything.
    const rows = await getVisualRowRects(titleEl);
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // Row 1 (top): ArrowDown must move the caret down WITHIN the title, not
    // hand off to the body.
    await clickTitleRow(page, "first");
    await expect(titleEl).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(titleEl).toBeFocused();
    await expect(page.locator(".cm-content:visible")).not.toBeFocused();

    // Last row (bottom): ArrowDown now crosses to the body.
    await clickTitleRow(page, "last");
    await expect(titleEl).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".cm-content:visible")).toBeFocused();
  });

  test("ArrowUp from a non-first body visual row stays in the body; from the first row crosses to the title", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "cr01-body-wrap.md",
      "",
      WRAPPED_NOTE_CONTENT,
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteInEditor(page, noteId);

    const wrappedLineText = "really long first line";
    const wrappedLine = page
      .locator(".cm-content:visible .cm-line", { hasText: wrappedLineText })
      .first();
    await expect(wrappedLine).toBeVisible({ timeout: 5_000 });
    // Sanity: the line must actually wrap to >=2 visual rows for this test to
    // prove anything.
    const rows = await getVisualRowRects(wrappedLine);
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // Watches for the title ever receiving focus — the crossing handoff
    // (EditorPane's handleCrossToTitle) focuses the title SYNCHRONOUSLY as
    // part of the same keydown task, so "never fired" is a direct, timing-
    // independent proof that no crossing was attempted (distinct from
    // "title focused briefly then something else refocused the body" — this
    // asserts the handoff path never ran at all).
    await page.evaluate(() => {
      (window as unknown as { __titleFocusEvents: number }).__titleFocusEvents = 0;
      document
        .querySelector('[data-testid="editor-title-element"]')
        ?.addEventListener("focus", () => {
          (window as unknown as { __titleFocusEvents: number }).__titleFocusEvents += 1;
        });
    });

    // A non-first visual row of the wrapped line: ArrowUp must move the
    // caret UP WITHIN the body (real CM6 vertical motion), never hand off to
    // the title.
    await clickBodyLineRow(page, wrappedLineText, "last");
    await expect(page.locator(".cm-content:visible")).toBeFocused();
    const caretBefore = await getCaretRect(page);
    if (!caretBefore) throw new Error("no caret rect measured before ArrowUp");

    await page.keyboard.press("ArrowUp");

    // The caret's own on-screen row moved UP within the body — proving CM6's
    // native vertical motion ran (not an intercepted-and-aborted crossing,
    // which would leave the caret exactly where it started).
    await expect
      .poll(async () => {
        const r = await getCaretRect(page);
        return r ? r.top : null;
      })
      .toBeLessThan(caretBefore.top);
    await expect(page.locator(".cm-content:visible")).toBeFocused();
    const titleFocusEvents = await page.evaluate(
      () => (window as unknown as { __titleFocusEvents: number }).__titleFocusEvents,
    );
    expect(titleFocusEvents).toBe(0);

    // The first visual row of the wrapped line: ArrowUp now crosses to the
    // title.
    await clickBodyLineRow(page, wrappedLineText, "first");
    await expect(page.locator(".cm-content:visible")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("editor-title-element")).toBeFocused();
  });

  test("UAT round-2 regression: ArrowUp from the genuine first visible line reaches the title even when the H1 is followed by a blank line", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "uat2-blank-after-h1.md",
      "",
      NOTE_CONTENT_BLANK_AFTER_H1,
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteInEditor(page, noteId);

    // Click the FIRST rendered `.cm-line` — the hidden H1 (plus the blank
    // line immediately following it, an emergent CM6 rendering merge —
    // firstH1HidePlugin.ts/titleBodyTraversal.ts header comments) is fully
    // collapsed, so the genuine first VISIBLE row is the paragraph itself.
    // Before the fix this area contained an extra, indistinguishable phantom
    // row left behind by the hidden H1.
    const firstLine = page.locator(".cm-content:visible .cm-line").first();
    await expect(firstLine).toBeVisible({ timeout: 5_000 });
    const box = await firstLine.boundingBox();
    if (!box) throw new Error("first .cm-line has no bounding box");
    await page.mouse.click(box.x + 2, box.y + box.height / 2);
    await expect(page.locator(".cm-content:visible")).toBeFocused();

    await page.keyboard.press("ArrowUp");

    // Assert the TITLE is actually focused (document.activeElement), not
    // merely "the body lost caret" — the prior agent's flagged false-pass
    // risk (a focus-revert quirk could leave neither element meaningfully
    // focused while still passing a weaker assertion).
    const titleFocused = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="editor-title-element"]');
      return el !== null && document.activeElement === el;
    });
    expect(titleFocused).toBe(true);
    await expect(page.getByTestId("editor-title-element")).toBeFocused();

    // No side-effect edit from the crossover itself.
    await expect
      .poll(async () => getNoteContent(page, jasper.baseURL, noteId), { timeout: 3_000 })
      .toBe(NOTE_CONTENT_BLANK_AFTER_H1);
  });

  test("UAT round-2 regression: exact default new-note scaffold (frontmatter + H1 + trailing blank line, no typed body yet) — ArrowUp from the body reaches the title", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    // Byte-identical to backend/internal/markdown/newnote.go's scaffoldFor().
    const scaffold = "---\ntags: []\n---\n\n# Fresh Note\n\n";
    const noteId = await apiCreateNote(page, jasper.baseURL, "uat2-scaffold.md", "", scaffold);

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteInEditor(page, noteId);

    // Only the trailing blank line renders below the (fully hidden) H1 —
    // clicking it exercises the "nothing left to skip to" edge case in
    // firstVisibleBodyLine() (a fresh note with no typed body yet must
    // still let ArrowUp reach the title).
    const firstLine = page.locator(".cm-content:visible .cm-line").first();
    await expect(firstLine).toBeVisible({ timeout: 5_000 });
    const box = await firstLine.boundingBox();
    if (!box) throw new Error("first .cm-line has no bounding box");
    await page.mouse.click(box.x + 2, box.y + box.height / 2);
    await expect(page.locator(".cm-content:visible")).toBeFocused();

    await page.keyboard.press("ArrowUp");

    await expect(page.getByTestId("editor-title-element")).toBeFocused();
  });

  for (const [label, content] of [
    ["H1 + blank line + body, no frontmatter", NOTE_NO_FRONTMATTER_BLANK_AFTER_H1],
    ["H1 + body, no blank line, no frontmatter", NOTE_NO_FRONTMATTER_NO_BLANK],
    ["frontmatter + H1 + blank line + body", NOTE_FRONTMATTER_BLANK_AFTER_H1],
  ] as const) {
    test(`UAT round 3 (#1): clicking the gap above the first body line then ArrowUp reaches the title — ${label}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1512, height: 944 });

      const noteId = await apiCreateNote(
        page,
        jasper.baseURL,
        `uat3-gap-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`,
        "",
        content,
      );

      await page.goto(jasper.baseURL);
      await waitForConnected(page);
      await openNoteInEditor(page, noteId);

      // Baseline read AFTER creation, not the literal `content` constant: a
      // frontmatter-less doc gets a scaffold injected server-side on save
      // (backend/internal/markdown frontmatter normalization), so the
      // persisted content can already differ from what was POSTed.
      const contentBefore = await getNoteContent(page, jasper.baseURL, noteId);

      await clickGapAboveFirstBodyLine(page);

      // Precondition matching the owner's report: the click lands the caret
      // at the top of the body (focus on the CM6 editor, not the title).
      await expect(page.locator(".cm-content:visible")).toBeFocused();

      await page.keyboard.press("ArrowUp");

      const titleFocused = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="editor-title-element"]');
        return el !== null && document.activeElement === el;
      });
      expect(titleFocused).toBe(true);
      await expect(page.getByTestId("editor-title-element")).toBeFocused();

      // No side-effect edit from the crossover itself.
      await expect
        .poll(async () => getNoteContent(page, jasper.baseURL, noteId), { timeout: 3_000 })
        .toBe(contentBefore);
    });
  }

  // UAT round 4: clicking the visual gap between the title and body, then
  // pressing Delete/Backspace, silently did nothing. Root cause: the click
  // resolves the caret to a position inside the hidden first-H1 region
  // (firstH1AtomicRanges only guards INCREMENTAL motion, not an absolute
  // click-set selection); Delete/Backspace there hit the atomic guard and
  // no-op. Fixed by firstH1SelectionClamp (snaps the caret to the first
  // visible body line on any absolute selection landing before it) +
  // firstH1BackspaceGuardKeymap (guards Backspace at that boundary without
  // silently eating keystrokes elsewhere) — see firstH1HidePlugin.ts.
  for (const [label, content] of [
    ["H1 + blank line + body, no frontmatter", NOTE_NO_FRONTMATTER_BLANK_AFTER_H1],
    ["H1 + body, no blank line, no frontmatter", NOTE_NO_FRONTMATTER_NO_BLANK],
    ["frontmatter + H1 + blank line + body", NOTE_FRONTMATTER_BLANK_AFTER_H1],
  ] as const) {
    test(`UAT round 4: clicking the gap then Delete removes the first body character — ${label}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1512, height: 944 });

      const noteId = await apiCreateNote(
        page,
        jasper.baseURL,
        `uat4-delete-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`,
        "",
        content,
      );

      await page.goto(jasper.baseURL);
      await waitForConnected(page);
      await openNoteInEditor(page, noteId);

      // Baseline AFTER creation — a frontmatter-less doc gets a scaffold
      // injected server-side, so the persisted content can already differ
      // from the literal `content` constant (see round-3 loop above).
      const contentBefore = await getNoteContent(page, jasper.baseURL, noteId);
      const bodyIdx = contentBefore.indexOf("Body paragraph");
      expect(bodyIdx).toBeGreaterThanOrEqual(0);

      await clickGapAboveFirstBodyLine(page);
      await expect(page.locator(".cm-content:visible")).toBeFocused();

      await page.keyboard.press("Delete");

      // The caret must have landed EXACTLY at the first visible body line's
      // start: forward Delete there removes precisely the first body
      // character, proving the click resolved to a real, visible position
      // (not a no-op inside the hidden preamble).
      const expected = contentBefore.slice(0, bodyIdx) + contentBefore.slice(bodyIdx + 1);
      await expect
        .poll(async () => getNoteContent(page, jasper.baseURL, noteId), { timeout: 5_000 })
        .toBe(expected);
    });

    test(`UAT round 4: clicking the gap then Backspace is a guarded no-op — title stays intact, focus stays in the body — ${label}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1512, height: 944 });

      const noteId = await apiCreateNote(
        page,
        jasper.baseURL,
        `uat4-backspace-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`,
        "",
        content,
      );

      await page.goto(jasper.baseURL);
      await waitForConnected(page);
      await openNoteInEditor(page, noteId);

      const contentBefore = await getNoteContent(page, jasper.baseURL, noteId);
      const titleTextBefore = await page.getByTestId("editor-title-element").innerText();
      const bodyTextBefore = await page.locator(".cm-content:visible").innerText();

      await clickGapAboveFirstBodyLine(page);
      await expect(page.locator(".cm-content:visible")).toBeFocused();

      await page.keyboard.press("Backspace");

      // Backspace at body-start does NOT cross to the title — it is a
      // guarded no-op. Focus stays in the body; nothing changes anywhere.
      await expect(page.locator(".cm-content:visible")).toBeFocused();
      const bodyTextAfter = await page.locator(".cm-content:visible").innerText();
      expect(bodyTextAfter).toBe(bodyTextBefore);
      const titleTextAfter = await page.getByTestId("editor-title-element").innerText();
      expect(titleTextAfter).toBe(titleTextBefore);

      await expect
        .poll(async () => getNoteContent(page, jasper.baseURL, noteId), { timeout: 3_000 })
        .toBe(contentBefore);
    });
  }

  test("UAT round-2 regression (superseded by round 3 #4): title/body column stays left-edge-aligned with itself in a wide pane", async ({
    page,
  }) => {
    // Wide viewport so the 760px reading column is well short of the full
    // pane width. Round 2 had additionally pinned the breadcrumb to this SAME
    // left edge; round 3 (#4) explicitly reversed that — the breadcrumb now
    // centers in the FULL bar instead (see the dedicated centering test
    // below) — so this test only re-asserts the still-unchanged title/body
    // alignment with EACH OTHER.
    await page.setViewportSize({ width: 1900, height: 944 });

    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "uat2-align.md",
      "",
      NOTE_CONTENT_BLANK_AFTER_H1,
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteInEditor(page, noteId);

    const titleBox = await page.getByTestId("editor-title-element").boundingBox();
    const paragraphLine = page
      .locator(".cm-content:visible .cm-line", { hasText: "Some real paragraph here." })
      .first();
    const paragraphBox = await paragraphLine.boundingBox();

    if (!titleBox || !paragraphBox) {
      throw new Error("missing bounding box for title/body");
    }

    // Title and body share the same left edge (within 1px of layout rounding).
    expect(Math.abs(titleBox.x - paragraphBox.x)).toBeLessThanOrEqual(1);
  });

  test("UAT round 3 (#4): breadcrumb centers in the FULL top-chrome bar, independent of the title/body column", async ({
    page,
  }) => {
    // Wide viewport so the 760px title/body column sits well left of the
    // bar's true horizontal center — the exact condition that would catch a
    // regression back to round 2's column-left-aligned breadcrumb.
    await page.setViewportSize({ width: 1900, height: 944 });

    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "uat3-breadcrumb-center.md",
      "",
      NOTE_CONTENT_BLANK_AFTER_H1,
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteInEditor(page, noteId);

    const barBox = await page.getByTestId("editor-top-chrome").boundingBox();
    const contentBox = await page.getByTestId("breadcrumb-content").boundingBox();
    const clusterBox = await page.getByTestId("editor-top-chrome-cluster").boundingBox();
    const titleBox = await page.getByTestId("editor-title-element").boundingBox();

    if (!barBox || !contentBox || !clusterBox || !titleBox) {
      throw new Error("missing bounding box for bar/breadcrumb-content/cluster/title");
    }

    // Centered in the FULL bar (within a couple px of rounding), not aligned
    // to the title's left edge.
    const barCenter = barBox.x + barBox.width / 2;
    const contentCenter = contentBox.x + contentBox.width / 2;
    expect(Math.abs(barCenter - contentCenter)).toBeLessThanOrEqual(2);

    // Proves this is genuinely a DIFFERENT alignment from round 2 (which
    // pinned the breadcrumb's left edge to the title's left edge) — at this
    // wide viewport the two must differ substantially.
    expect(Math.abs(contentBox.x - titleBox.x)).toBeGreaterThan(50);

    // Never overlaps the right-pinned cluster ([favorite, ⋯]).
    expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(clusterBox.x);
  });

  test("UAT round 3 (#5): the title's first GLYPH lines up with the body's first GLYPH, not just their container boxes", async ({
    page,
  }) => {
    // Deliberately measures TEXT (Range.getClientRects()), not element
    // boundingBox(): CM6's own baseTheme applies `.cm-line { padding: 0 2px 0
    // 6px }` unconditionally (themeBridge.ts) — a 6px left inset on the
    // BODY'S TEXT that TitleElement.tsx's 0-padding contentEditable div
    // doesn't share. That inset lives INSIDE `.cm-line`'s own box, so
    // `.cm-line`'s boundingBox().x is unaffected and stays aligned even while
    // the actual rendered ink is shifted 6px right — exactly why the
    // existing box-based alignment test above did not catch this.
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "uat3-glyph-align.md",
      "",
      NOTE_CONTENT_BLANK_AFTER_H1,
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteInEditor(page, noteId);

    const textLeftEdges = await page.evaluate(() => {
      const titleEl = document.querySelector('[data-testid="editor-title-element"]');
      // v1.2 keep-alive tabs can leave hidden `.cm-content` nodes mounted
      // (mirrors openNoteInEditor's own `:visible` scoping above) — plain
      // `document.querySelector` has no `:visible` pseudo-class, so filter
      // by `offsetParent` (null when the element or an ancestor is
      // display:none) to find the ACTIVE pane's content.
      const lineEl = Array.from(document.querySelectorAll(".cm-content .cm-line")).find(
        (el) => (el as HTMLElement).offsetParent !== null,
      );
      if (!titleEl || !lineEl) return null;

      const titleRange = document.createRange();
      titleRange.selectNodeContents(titleEl);
      const titleRect = titleRange.getClientRects()[0];

      const lineRange = document.createRange();
      lineRange.selectNodeContents(lineEl);
      const lineRect = lineRange.getClientRects()[0];

      return {
        titleTextLeft: titleRect?.left ?? null,
        lineTextLeft: lineRect?.left ?? null,
      };
    });

    if (!textLeftEdges || textLeftEdges.titleTextLeft === null || textLeftEdges.lineTextLeft === null) {
      throw new Error("could not measure title/body text rects");
    }

    expect(
      Math.abs(textLeftEdges.titleTextLeft - textLeftEdges.lineTextLeft),
    ).toBeLessThanOrEqual(1);
  });

  test("UAT round 3 (#3): responsive top-chrome cluster — star hides at narrow pane widths, the ⋯ note-options menu never hides; word count lives in the status bar and is NOT gated by the editor pane's width", async ({
    page,
  }) => {
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "responsive-chrome.md",
      "",
      NOTE_CONTENT_BLANK_AFTER_H1,
    );

    // Wide viewport: star + ⋯ both show. Word count no longer lives in this
    // per-pane cluster at all (moved to the status bar, UAT round 3 #6).
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteInEditor(page, noteId);

    await expect(page.getByTestId("editor-top-chrome-cluster").getByTestId("word-count")).toHaveCount(0);
    await expect(page.getByTestId("bookmark-star")).toBeVisible();
    await expect(page.getByRole("button", { name: "Note options" })).toBeVisible();
    await expect(page.getByTestId("status-bar-word-count")).toBeVisible();

    // Collapse the left sidebar so the editor pane's own width (what
    // computeChromeVisibility actually measures via ResizeObserver on the
    // bar — a per-pane width, not a window-width media query) tracks the
    // viewport directly, then shrink the viewport itself to narrow the bar.
    const collapseBtn = page.getByRole("button", { name: "Collapse sidebar" });
    if (await collapseBtn.isVisible()) {
      await collapseBtn.click();
    }

    await page.setViewportSize({ width: 360, height: 900 });

    await expect(page.getByTestId("bookmark-star")).toBeHidden();
    await expect(page.getByRole("button", { name: "Note options" })).toBeVisible();
    // Status bar word count is driven by the WINDOW-level status bar, not the
    // editor pane's own measured width — it stays visible even once the
    // pane's own top-chrome cluster has shed the star.
    await expect(page.getByTestId("status-bar-word-count")).toBeVisible();

    // Widen back out — the star reappears (proves this is width-driven, not a
    // one-way/sticky hide).
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId("bookmark-star")).toBeVisible();
    await expect(page.getByRole("button", { name: "Note options" })).toBeVisible();
  });
});
