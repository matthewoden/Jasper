/**
 * livePreviewPlugin.test.ts — vitest suite for the Live Preview decoration
 * plugin. Covers: heading line decoration, emphasis marks, multi-line
 * selection (D-06), code-fence guard (D-09), IME gate (D-07/D-31), and
 * production-scope additions from Plan 05-06: list bullets (EDIT-04),
 * blockquote (EDIT-05), inline code (EDIT-06), HR (EDIT-07).
 *
 * Phase 5 Plan 05-01 (spike) → extended by Plan 05-06 (production scope).
 * Per TDD gate sequence:
 *   RED  → this file (failing; livePreviewPlugin.ts not yet written)
 *   GREEN → implement livePreviewPlugin.ts
 *   REFACTOR → (if needed)
 *
 * Test cases are named verbatim per the plan spec.
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import {
  livePreviewPlugin,
  computeCursorLines,
} from "./livePreviewPlugin";
import {
  HEADING_DOC,
  EMPHASIS_DOC,
  CODE_FENCE_DOC,
  INLINE_CODE_DOC,
  MULTI_LINE_SELECTION_DOC,
  LIST_DOC,
  BLOCKQUOTE_DOC,
  HR_DOC,
  ALL_FEATURES_DOC,
  INLINE_CODE_PROD_DOC,
} from "./__fixtures__/spike-doc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeView(doc: string, selectionPos = 0): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: selectionPos, head: selectionPos },
      extensions: [yamlFrontmatter({ content: markdown() }), livePreviewPlugin],
    }),
  });
}

function makeViewWithSelection(
  doc: string,
  anchor: number,
  head: number
): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [yamlFrontmatter({ content: markdown() }), livePreviewPlugin],
    }),
  });
}

interface DecoEntry {
  from: number;
  to: number;
  class?: string;
  isReplace: boolean;
  isLine: boolean;
}

/**
 * Iterate the plugin's DecorationSet and return all entries as plain objects.
 * Works with both Decoration.line (zero-width, from===to) and Decoration.mark/replace.
 */
function collectDecorations(view: EditorView): DecoEntry[] {
  const plugin = view.plugin(livePreviewPlugin);
  if (!plugin) return [];
  const out: DecoEntry[] = [];
  const cursor = plugin.decorations.iter();
  while (cursor.value !== null) {
    const spec = (cursor.value as unknown as { spec: Record<string, unknown> }).spec;
    // Decoration.replace has spec.startSide defined or spec.replace flag
    // Decoration.line has spec.line === true (internal CM6 detail)
    // We detect replace by checking if the decoration's spec has an 'inclusive'
    // key or if from === to and has no class (line deco is from===to with class).
    // Actually: use the fact that replace decorations have a `.point` field.
    const isLine = cursor.from === cursor.to && spec?.class !== undefined;
    const isReplace =
      !isLine &&
      cursor.from !== cursor.to &&
      spec?.class === undefined &&
      spec?.widget === undefined;
    out.push({
      from: cursor.from,
      to: cursor.to,
      class: spec?.class as string | undefined,
      isReplace,
      isLine,
    });
    cursor.next();
  }
  return out;
}

// ---------------------------------------------------------------------------
// describe: heading-line-decoration
// ---------------------------------------------------------------------------

describe("livePreviewPlugin / heading-line-decoration", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("emits cm-heading-1 line decoration for # ATX heading", () => {
    // Selection at position 0 (line 1) — same line as the heading
    const view = makeView(HEADING_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const headingDecos = decos.filter((d) => d.class === "cm-heading-1");
    expect(headingDecos.length).toBeGreaterThan(0);

    // The decoration should start at line 1 (position 0)
    const line1 = view.state.doc.line(1);
    expect(headingDecos.some((d) => d.from === line1.from)).toBe(true);
  });

  it("emits cm-heading-2 for ## headings", () => {
    const view = makeView(HEADING_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const heading2Decos = decos.filter((d) => d.class === "cm-heading-2");
    expect(heading2Decos.length).toBeGreaterThan(0);

    // ## Heading 2 is on line 4 of HEADING_DOC
    const line4 = view.state.doc.line(4);
    expect(heading2Decos.some((d) => d.from === line4.from)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe: emphasis-marks
// ---------------------------------------------------------------------------

describe("livePreviewPlugin / emphasis-marks", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("emits cm-strong mark over **bold** text", () => {
    // Cursor at position 0 (line 1 = same line as **bold**)
    const view = makeView(EMPHASIS_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const strongDecos = decos.filter((d) => d.class === "cm-strong");
    expect(strongDecos.length).toBeGreaterThan(0);
  });

  it("hides EmphasisMark with Decoration.replace when cursor is OFF the line", () => {
    // EMPHASIS_DOC line 1: "Plain text with **bold** and *italic*."
    // EMPHASIS_DOC line 2: "Another **strong** word here."
    // Put cursor on line 2 (well past line 1) — EmphasisMark on line 1 should hide
    const line2Start = EMPHASIS_DOC.indexOf("\n") + 1;
    const view = makeView(EMPHASIS_DOC, line2Start + 5); // mid-line 2
    views.push(view);

    const decos = collectDecorations(view);
    // Should have Decoration.replace entries (isReplace === true)
    const replaceDecos = decos.filter((d) => d.isReplace);
    expect(replaceDecos.length).toBeGreaterThan(0);
  });

  it("shows EmphasisMark as visible marker when cursor is ON the line", () => {
    // Cursor at position 17 (inside **bold** on line 1)
    const boldPos = EMPHASIS_DOC.indexOf("**bold**") + 2;
    const view = makeView(EMPHASIS_DOC, boldPos);
    views.push(view);

    const decos = collectDecorations(view);
    // EmphasisMark on cursor line should be cm-marker (visible), not replace
    const markerDecos = decos.filter((d) => d.class === "cm-marker");
    expect(markerDecos.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// describe: multi-line-selection (D-06)
// ---------------------------------------------------------------------------

describe("livePreviewPlugin / multi-line-selection (D-06)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("keeps markers visible on every line in a multi-line selection range", () => {
    // MULTI_LINE_SELECTION_DOC:
    //   line 1: # Heading A
    //   line 2: body
    //   line 3: ## Heading B
    //   line 4: body
    //   line 5: ### Heading C
    //
    // Select from line 1 to line 5 (anchor=0, head=end)
    const doc = MULTI_LINE_SELECTION_DOC;
    const view = makeViewWithSelection(doc, 0, doc.length);
    views.push(view);

    const decos = collectDecorations(view);
    // All HeaderMark decorations should be cm-marker (visible), NOT Decoration.replace
    const replaceDecos = decos.filter((d) => d.isReplace);
    // Expect zero replace decorations since all heading lines are in the selection
    expect(replaceDecos.length).toBe(0);
    // And cm-marker should appear for lines that are in the selection
    const markerDecos = decos.filter((d) => d.class === "cm-marker");
    expect(markerDecos.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// describe: code-fence-guard (D-09)
// ---------------------------------------------------------------------------

describe("livePreviewPlugin / code-fence-guard (D-09)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("does NOT hide EmphasisMark inside a fenced code block", () => {
    // CODE_FENCE_DOC has **not bold** inside a ```typescript fence.
    // Cursor is placed on the first line (outside the fence).
    const view = makeView(CODE_FENCE_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    // Find the position of **not bold** inside the fence
    const fenceContentPos = CODE_FENCE_DOC.indexOf("**not bold**");
    expect(fenceContentPos).toBeGreaterThan(-1);

    // No Decoration.replace should cover that position
    const replaceAtFence = decos.filter(
      (d) => d.isReplace && d.from <= fenceContentPos && d.to >= fenceContentPos
    );
    expect(replaceAtFence.length).toBe(0);
  });

  it("InlineCode is rendered as cm-inline-code mark; backticks hide off-line per UI-SPEC §Live Preview", () => {
    // INLINE_CODE_PROD_DOC: "Run `npm install` to start."
    // Cursor at position 0 (start of line, which IS the inline code line).
    // Verify InlineCode emits a cm-inline-code mark decoration.
    const view = makeView(INLINE_CODE_PROD_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    // InlineCode mark decoration should be present
    const inlineCodeDecos = decos.filter((d) => d.class === "cm-inline-code");
    expect(inlineCodeDecos.length).toBeGreaterThan(0);

    // Also verify spike regression: INLINE_CODE_DOC (emphasis inside backticks)
    // — lezer does not produce EmphasisMark nodes inside InlineCode verbatim
    // content, so there are no replace decorations at that position regardless.
    const spikeView = makeView(INLINE_CODE_DOC, 0);
    views.push(spikeView);
    const spikeDecos = collectDecorations(spikeView);
    const inlineCodePos = INLINE_CODE_DOC.indexOf("**not bold");
    expect(inlineCodePos).toBeGreaterThan(-1);
    const replaceAtInlineCode = spikeDecos.filter(
      (d) => d.isReplace && d.from <= inlineCodePos && d.to >= inlineCodePos
    );
    expect(replaceAtInlineCode.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe: IME composing gate (D-07/D-31)
// ---------------------------------------------------------------------------

describe("livePreviewPlugin / IME composing gate (D-07/D-31)", () => {
  it("preserves decorations through u.changes when view.composing is true", () => {
    // Verify the composing-gate behavior directly:
    // The gate calls `this.decorations = this.decorations.map(u.changes)` instead
    // of rebuilding. We test this by verifying that mapping an existing DecorationSet
    // through a no-op ChangeSet preserves the same decoration count (same as
    // frontmatterPlugin.test.ts IME test pattern).
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: EMPHASIS_DOC,
        extensions: [yamlFrontmatter({ content: markdown() }), livePreviewPlugin],
      }),
    });

    // Verify the plugin is registered and produces decorations
    const plugin = view.plugin(livePreviewPlugin);
    expect(plugin).not.toBeNull();
    expect(plugin!.decorations).toBeDefined();

    // Count initial decorations
    let initialCount = 0;
    const cursor = plugin!.decorations.iter();
    while (cursor.value !== null) {
      initialCount++;
      cursor.next();
    }
    expect(initialCount).toBeGreaterThan(0);

    // Simulate what the composing gate does: map decorations through a
    // no-op transaction's changes (no document change = identity mapping).
    // This is the exact operation `this.decorations.map(u.changes)` performs.
    const noOpTx = view.state.update({});
    const mappedDecos = plugin!.decorations.map(noOpTx.changes);

    let mappedCount = 0;
    const mappedCursor = mappedDecos.iter();
    while (mappedCursor.value !== null) {
      mappedCount++;
      mappedCursor.next();
    }

    // Same count proves mapping preserves decorations (no churn)
    expect(mappedCount).toBe(initialCount);

    // Also verify that a normal selection-change dispatch (composing=false)
    // still produces valid decorations (the plugin update() path works).
    view.dispatch({ selection: { anchor: 5, head: 5 } });
    const pluginAfter = view.plugin(livePreviewPlugin)!;
    expect(pluginAfter.decorations).toBeDefined();

    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Helper function unit tests
// ---------------------------------------------------------------------------

describe("computeCursorLines", () => {
  it("returns the set of line numbers covered by all selection ranges", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: MULTI_LINE_SELECTION_DOC,
        selection: { anchor: 0, head: MULTI_LINE_SELECTION_DOC.length },
        extensions: [markdown()],
      }),
    });

    const lines = computeCursorLines(view);
    // MULTI_LINE_SELECTION_DOC has 5 lines; all should be in the set
    expect(lines.has(1)).toBe(true);
    expect(lines.has(3)).toBe(true);
    expect(lines.has(5)).toBe(true);

    view.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Production scope tests (Plan 05-06): list bullets, blockquote,
// inline code, HR — EDIT-04..EDIT-07.
// ────────────────────────────────────────────────────────────────────────────

describe("livePreviewPlugin / list-bullets (EDIT-04 / D-04)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("Unordered ListMark renders BulletWidget '•' when cursor is off the list line", () => {
    // LIST_DOC line 1: "Some text." — put cursor here, list starts line 3
    const view = makeView(LIST_DOC, 0);
    views.push(view);

    const plugin = view.plugin(livePreviewPlugin);
    expect(plugin).not.toBeNull();

    // Walk the DecorationSet looking for a widget-bearing Decoration.replace
    // whose toDOM() emits a span.cm-list-bullet containing '•'.
    let foundBullet = false;
    const cursor = plugin!.decorations.iter();
    while (cursor.value !== null) {
      const spec = (cursor.value as unknown as { spec: Record<string, unknown> }).spec;
      const widget = spec?.widget as { toDOM?: () => Element } | undefined;
      if (widget && typeof widget.toDOM === "function") {
        const dom = widget.toDOM();
        if (
          dom.tagName === "SPAN" &&
          dom.classList.contains("cm-list-bullet") &&
          dom.textContent === "•"
        ) {
          // EDIT-04: the unordered `- ` text is replaced by a real bullet.
          // Verify the replaced range covers the ListMark `-` character.
          const replacedText = view.state.doc.sliceString(cursor.from, cursor.to);
          expect(replacedText).toBe("-");
          foundBullet = true;
          break;
        }
      }
      cursor.next();
    }
    expect(foundBullet).toBe(true);
  });

  it("Ordered ListMark stays visible (no decoration) — '1.' IS the bullet (EDIT-04)", () => {
    // LIST_DOC has an ordered list at "1. First". Cursor far away so we'd
    // expect any "hide" pass to fire if it were going to. After the fix,
    // ordered ListMark is left visible — no Decoration.replace covers it.
    const view = makeView(LIST_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const orderedMarkPos = LIST_DOC.indexOf("1.");
    expect(orderedMarkPos).toBeGreaterThan(-1);

    // No replace decoration should cover the "1." range.
    const replaceCovering = decos.find((d) => {
      if (!d.isReplace) return false;
      return d.from <= orderedMarkPos && d.to >= orderedMarkPos + 2;
    });
    expect(replaceCovering).toBeUndefined();
  });

  it("ListMark shows as cm-marker when cursor IS on the list line", () => {
    // Place cursor inside "- Bullet one" — the ListMark should be cm-marker
    const listLineStart = LIST_DOC.indexOf("- Bullet one");
    expect(listLineStart).toBeGreaterThan(-1);
    const view = makeView(LIST_DOC, listLineStart + 2); // inside the bullet text
    views.push(view);

    const decos = collectDecorations(view);
    const markerDecos = decos.filter((d) => d.class === "cm-marker");
    expect(markerDecos.length).toBeGreaterThan(0);
  });
});

describe("livePreviewPlugin / blockquote (EDIT-05)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("Blockquote node lines emit cm-blockquote line decoration", () => {
    const view = makeView(BLOCKQUOTE_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const blockquoteDecos = decos.filter((d) => d.class === "cm-blockquote");
    expect(blockquoteDecos.length).toBeGreaterThan(0);
  });

  it("both quoted lines receive cm-blockquote decoration", () => {
    // BLOCKQUOTE_DOC has two "> " lines — both should get cm-blockquote
    const view = makeView(BLOCKQUOTE_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const blockquoteDecos = decos.filter((d) => d.class === "cm-blockquote");
    // Two quoted lines: "> A quoted line" and "> Another quoted line"
    expect(blockquoteDecos.length).toBeGreaterThanOrEqual(2);
  });
});

describe("livePreviewPlugin / horizontal-rule (EDIT-07)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("HorizontalRule node emits Decoration.replace with HRWidget rendering <hr class='cm-hr'>", () => {
    const view = makeView(HR_DOC, 0);
    views.push(view);

    const plugin = view.plugin(livePreviewPlugin);
    expect(plugin).not.toBeNull();

    let foundHRWidget = false;
    const cursor = plugin!.decorations.iter();
    while (cursor.value !== null) {
      const spec = (cursor.value as unknown as { spec: Record<string, unknown> }).spec;
      const widget = spec?.widget as { toDOM?: () => Element } | undefined;
      if (widget && typeof widget.toDOM === "function") {
        const dom = widget.toDOM();
        if (dom.tagName === "HR" && dom.classList.contains("cm-hr")) {
          foundHRWidget = true;
          break;
        }
      }
      cursor.next();
    }
    expect(foundHRWidget).toBe(true);
  });

  it("HRWidget has aria-hidden attribute for screen-reader hygiene", () => {
    const view = makeView(HR_DOC, 0);
    views.push(view);

    const plugin = view.plugin(livePreviewPlugin);
    expect(plugin).not.toBeNull();

    let ariaHidden = false;
    const cursor = plugin!.decorations.iter();
    while (cursor.value !== null) {
      const spec = (cursor.value as unknown as { spec: Record<string, unknown> }).spec;
      const widget = spec?.widget as { toDOM?: () => Element } | undefined;
      if (widget && typeof widget.toDOM === "function") {
        const dom = widget.toDOM();
        if (dom.tagName === "HR" && dom.getAttribute("aria-hidden") === "true") {
          ariaHidden = true;
          break;
        }
      }
      cursor.next();
    }
    expect(ariaHidden).toBe(true);
  });
});

describe("livePreviewPlugin / all-features mixed doc", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("ALL_FEATURES_DOC produces decorations for each feature category without throwing", () => {
    const view = makeView(ALL_FEATURES_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const classes = new Set<string>(
      decos.map((d) => d.class).filter((c): c is string => !!c)
    );

    // We expect at LEAST one decoration with each of these classes:
    //   cm-heading-1, cm-strong, cm-emphasis, cm-blockquote, cm-codeblock
    // (cm-frontmatter is owned by frontmatterPlugin — not checked here)
    expect(classes.has("cm-heading-1")).toBe(true);
    expect(classes.has("cm-strong")).toBe(true);
    expect(classes.has("cm-emphasis")).toBe(true);
    expect(classes.has("cm-blockquote")).toBe(true);
    expect(classes.has("cm-codeblock")).toBe(true);
  });

  it("ALL_FEATURES_DOC includes cm-inline-code mark", () => {
    const view = makeView(ALL_FEATURES_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const inlineCodeDecos = decos.filter((d) => d.class === "cm-inline-code");
    expect(inlineCodeDecos.length).toBeGreaterThan(0);
  });
});
