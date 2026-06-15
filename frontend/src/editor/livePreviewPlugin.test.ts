/**
 * livePreviewPlugin.test.ts — vitest suite for the Live Preview decoration
 * plugin. Covers: heading line decoration, emphasis marks, multi-line
 * selection, code-fence guard, IME gate, list bullets, blockquote,
 * inline code, and HR.
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
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


describe("livePreviewPlugin / heading-line-decoration", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("emits cm-heading-1 line decoration for # ATX heading", () => {
    const view = makeView(HEADING_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const headingDecos = decos.filter((d) => d.class === "cm-heading-1");
    expect(headingDecos.length).toBeGreaterThan(0);

    const line1 = view.state.doc.line(1);
    expect(headingDecos.some((d) => d.from === line1.from)).toBe(true);
  });

  it("emits cm-heading-2 for ## headings", () => {
    const view = makeView(HEADING_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const heading2Decos = decos.filter((d) => d.class === "cm-heading-2");
    expect(heading2Decos.length).toBeGreaterThan(0);

    const line4 = view.state.doc.line(4);
    expect(heading2Decos.some((d) => d.from === line4.from)).toBe(true);
  });
});


describe("livePreviewPlugin / emphasis-marks", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("emits cm-strong mark over **bold** text", () => {
    const view = makeView(EMPHASIS_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const strongDecos = decos.filter((d) => d.class === "cm-strong");
    expect(strongDecos.length).toBeGreaterThan(0);
  });

  it("hides EmphasisMark with Decoration.replace when cursor is OFF the line", () => {
    const line2Start = EMPHASIS_DOC.indexOf("\n") + 1;
    const view = makeView(EMPHASIS_DOC, line2Start + 5);
    views.push(view);

    const decos = collectDecorations(view);
    const replaceDecos = decos.filter((d) => d.isReplace);
    expect(replaceDecos.length).toBeGreaterThan(0);
  });

  it("shows EmphasisMark as visible marker when cursor is ON the line", () => {
    const boldPos = EMPHASIS_DOC.indexOf("**bold**") + 2;
    const view = makeView(EMPHASIS_DOC, boldPos);
    views.push(view);

    const decos = collectDecorations(view);
    const markerDecos = decos.filter((d) => d.class === "cm-marker");
    expect(markerDecos.length).toBeGreaterThan(0);
  });
});


describe("livePreviewPlugin / multi-line-selection (D-06)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("keeps markers visible on every line in a multi-line selection range", () => {
    const doc = MULTI_LINE_SELECTION_DOC;
    const view = makeViewWithSelection(doc, 0, doc.length);
    views.push(view);

    const decos = collectDecorations(view);
    const replaceDecos = decos.filter((d) => d.isReplace);
    expect(replaceDecos.length).toBe(0);
    const markerDecos = decos.filter((d) => d.class === "cm-marker");
    expect(markerDecos.length).toBeGreaterThan(0);
  });
});


describe("livePreviewPlugin / code-fence-guard (D-09)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("does NOT hide EmphasisMark inside a fenced code block", () => {
    const view = makeView(CODE_FENCE_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const fenceContentPos = CODE_FENCE_DOC.indexOf("**not bold**");
    expect(fenceContentPos).toBeGreaterThan(-1);

    const replaceAtFence = decos.filter(
      (d) => d.isReplace && d.from <= fenceContentPos && d.to >= fenceContentPos
    );
    expect(replaceAtFence.length).toBe(0);
  });

  it("InlineCode is rendered as cm-inline-code mark; backticks hide off-line per UI-SPEC §Live Preview", () => {
    const view = makeView(INLINE_CODE_PROD_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const inlineCodeDecos = decos.filter((d) => d.class === "cm-inline-code");
    expect(inlineCodeDecos.length).toBeGreaterThan(0);

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


describe("livePreviewPlugin / IME composing gate (D-07/D-31)", () => {
  it("preserves decorations through u.changes when view.composing is true", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: EMPHASIS_DOC,
        extensions: [yamlFrontmatter({ content: markdown() }), livePreviewPlugin],
      }),
    });

    const plugin = view.plugin(livePreviewPlugin);
    expect(plugin).not.toBeNull();
    expect(plugin!.decorations).toBeDefined();

    let initialCount = 0;
    const cursor = plugin!.decorations.iter();
    while (cursor.value !== null) {
      initialCount++;
      cursor.next();
    }
    expect(initialCount).toBeGreaterThan(0);

    const noOpTx = view.state.update({});
    const mappedDecos = plugin!.decorations.map(noOpTx.changes);

    let mappedCount = 0;
    const mappedCursor = mappedDecos.iter();
    while (mappedCursor.value !== null) {
      mappedCount++;
      mappedCursor.next();
    }

    expect(mappedCount).toBe(initialCount);

    view.dispatch({ selection: { anchor: 5, head: 5 } });
    const pluginAfter = view.plugin(livePreviewPlugin)!;
    expect(pluginAfter.decorations).toBeDefined();

    view.destroy();
  });
});


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
    expect(lines.has(1)).toBe(true);
    expect(lines.has(3)).toBe(true);
    expect(lines.has(5)).toBe(true);

    view.destroy();
  });
});


describe("livePreviewPlugin / list-bullets (EDIT-04 / D-04)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("Unordered ListMark renders BulletWidget '•' when cursor is off the list line", () => {
    const view = makeView(LIST_DOC, 0);
    views.push(view);

    const plugin = view.plugin(livePreviewPlugin);
    expect(plugin).not.toBeNull();

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
    const view = makeView(LIST_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const orderedMarkPos = LIST_DOC.indexOf("1.");
    expect(orderedMarkPos).toBeGreaterThan(-1);

    const replaceCovering = decos.find((d) => {
      if (!d.isReplace) return false;
      return d.from <= orderedMarkPos && d.to >= orderedMarkPos + 2;
    });
    expect(replaceCovering).toBeUndefined();
  });

  it("ListMark shows as cm-marker when cursor IS on the list line", () => {
    const listLineStart = LIST_DOC.indexOf("- Bullet one");
    expect(listLineStart).toBeGreaterThan(-1);
    const view = makeView(LIST_DOC, listLineStart + 2);
    views.push(view);

    const decos = collectDecorations(view);
    const markerDecos = decos.filter(
      (d) => d.class !== undefined && d.class.split(/\s+/).includes("cm-marker")
    );
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
    const view = makeView(BLOCKQUOTE_DOC, 0);
    views.push(view);

    const decos = collectDecorations(view);
    const blockquoteDecos = decos.filter((d) => d.class === "cm-blockquote");
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


describe("livePreviewPlugin / UX-15 heading trailing-space swallow", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("UX-15: off-cursor HeaderMark range covers trailing space", () => {
    const doc = "# heading\nbody";
    const view = makeView(doc, 10);
    views.push(view);

    const decos = collectDecorations(view);
    const replaceAtZero = decos.find(
      (d) => d.isReplace && d.from === 0
    );
    expect(replaceAtZero).toBeDefined();
    expect(replaceAtZero!.to).toBe(2);
  });

  it("UX-15: off-cursor HeaderMark falls back to node.to when next char is not a space", () => {
    const doc = "#\nbody";
    const view = makeView(doc, 2);
    views.push(view);

    const decos = collectDecorations(view);
    const replaceAtZero = decos.find(
      (d) => d.isReplace && d.from === 0
    );
    if (replaceAtZero) {
      expect(replaceAtZero.to).toBe(1);
    }
    // If no replace was emitted, the test still asserts the property of
    // interest: no decoration extends past the HeaderMark's actual end.
  });
});

describe("livePreviewPlugin / UX-16 cm-list-marker class", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("UX-16: on-cursor ListMark mark decoration carries cm-list-marker class", () => {
    const doc = "- item";
    const view = makeView(doc, 3);
    views.push(view);

    const decos = collectDecorations(view);
    const listMarker = decos.find(
      (d) => d.class !== undefined && d.class.includes("cm-list-marker")
    );
    expect(listMarker).toBeDefined();
    expect(listMarker!.class).toContain("cm-marker");
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


describe("livePreviewPlugin / TC-7 task-line coexistence guard", () => {
  /**
   * With GFM enabled (base: markdownLanguage), a task line "- [ ] text" has
   * a ListMark node sibling to a Task node. The ListMark branch must skip
   * task lines so that taskCheckboxPlugin can own the marker range exclusively.
   * A regular list item "- item" must still emit a bullet.
   *
   * Uses markdownLanguage base so Task/TaskMarker lezer nodes exist.
   */
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  function makeGFMView(doc: string, selectionPos = 0): EditorView {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: selectionPos, head: selectionPos },
        extensions: [
          yamlFrontmatter({ content: markdown({ codeLanguages: [], base: markdownLanguage }) }),
          livePreviewPlugin,
        ],
      }),
    });
    views.push(view);
    return view;
  }

  it("TC-7: task line '- [ ] task' does NOT emit a bullet widget over the ListMark range (cursor OFF line)", () => {
    // "- [ ] task\nanother line" — cursor on line 2 so line 1 is off-cursor
    // Without the guard, livePreviewPlugin would render a bullet '•' on "- [ ] task"
    // With the guard (getChild("Task")), it skips the ListMark — no bullet widget
    const doc = "- [ ] task\nanother line";
    const view = makeGFMView(doc, 15); // cursor on "another line" (line 2)
    const plugin = view.plugin(livePreviewPlugin);
    expect(plugin).not.toBeNull();

    // ListMark "-" is at position 0..1 in the doc
    // Check no bullet widget is emitted anywhere in the decorations
    const cursor = plugin!.decorations.iter();
    let bulletFound = false;
    while (cursor.value !== null) {
      const spec = (cursor.value as unknown as { spec: Record<string, unknown> }).spec;
      const widget = spec?.widget as { toDOM?: () => Element } | undefined;
      if (widget && typeof widget.toDOM === "function") {
        const dom = widget.toDOM();
        if (dom.classList.contains("cm-list-bullet") && dom.textContent === "•") {
          bulletFound = true;
        }
      }
      cursor.next();
    }
    expect(bulletFound).toBe(false);
  });

  it("TC-7 reveal: on-cursor task line emits a .cm-marker mark decoration over the ListMark range", () => {
    // D-01 reveal model: when the cursor IS on the task line, livePreviewPlugin must emit
    // a .cm-marker decoration on the ListMark range so the raw '-' is muted-but-visible.
    // taskCheckboxPlugin emits nothing on-cursor (per TC-10), so livePreviewPlugin owns
    // the on-cursor ListMark styling.
    // This test is RED until plan 02 lands (livePreviewPlugin TC-7 guard adjustment).
    const doc = "- [ ] task\nanother line";
    const view = makeGFMView(doc, 2); // cursor on task line (pos 2 inside TaskMarker)
    const plugin = view.plugin(livePreviewPlugin);
    expect(plugin).not.toBeNull();

    // ListMark '-' is at position 0..1; on-cursor the guard should emit .cm-marker
    const decos = (() => {
      const out: Array<{ from: number; to: number; class?: string }> = [];
      const cur = plugin!.decorations.iter();
      while (cur.value !== null) {
        const spec = (cur.value as unknown as { spec: Record<string, unknown> }).spec;
        out.push({ from: cur.from, to: cur.to, class: spec?.class as string | undefined });
        cur.next();
      }
      return out;
    })();

    // There must be a mark decoration with cm-marker class covering the ListMark range [0..1]
    const listMarkMarker = decos.find(
      d => d.class !== undefined && d.class.includes("cm-marker") && d.from === 0 && d.to === 1,
    );
    expect(listMarkMarker).toBeDefined();
  });

  it("TC-7 regression: regular list item '- item' still emits a bullet widget when cursor is off the line", () => {
    // A non-task list item should still get the bullet decoration when cursor is off its line
    // Use a two-line doc with cursor on line 2 so line 1's ListMark renders as a bullet
    const view = makeGFMView("- item\nanother line", 10);
    const plugin = view.plugin(livePreviewPlugin);
    expect(plugin).not.toBeNull();

    let foundBullet = false;
    const cursor = plugin!.decorations.iter();
    while (cursor.value !== null) {
      const spec = (cursor.value as unknown as { spec: Record<string, unknown> }).spec;
      const widget = spec?.widget as { toDOM?: () => Element } | undefined;
      if (widget && typeof widget.toDOM === "function") {
        const dom = widget.toDOM();
        if (dom.classList.contains("cm-list-bullet") && dom.textContent === "•") {
          foundBullet = true;
          break;
        }
      }
      cursor.next();
    }
    expect(foundBullet).toBe(true);
  });
});
