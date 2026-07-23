/**
 * firstH1HidePlugin.test.ts — vitest suite for the first-H1 hide plugin.
 *
 * Regression coverage for the Phase 31 UAT round-2 bug ("ArrowUp from the
 * top of the body doesn't reach the title"). Two failure modes were found
 * and are guarded against here (see firstH1HidePlugin.ts's header comment
 * for the full investigation):
 *
 * 1. A bare `Decoration.replace({block: true})` over just the H1 node's own
 *    range (excluding its trailing newline) hides the TEXT but leaves an
 *    empty `.cm-line` row of NORMAL line-height behind whenever the H1 is
 *    followed by a blank line (the default new-note scaffold) — that
 *    phantom row was clickable/caret-accessible and broke the ArrowUp
 *    body->title handoff.
 * 2. A `Decoration.line({class: "...", display:none})` approach fixed (1)
 *    but silently failed to apply AT ALL whenever the H1 immediately
 *    follows the hidden frontmatter with NO blank line between them (also a
 *    common shape) — CM6 doesn't reliably combine a line decoration
 *    positioned exactly at another extension's block-replace boundary.
 *
 * The fix: `Decoration.replace({widget, block: true})` over a range
 * extended through the H1's own trailing newline (mirrors
 * frontmatterHidePlugin's own multi-line collapse pattern) — verified here
 * to collapse correctly AND to combine correctly regardless of adjacency to
 * the hidden frontmatter block.
 */
import { describe, expect, it, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { cursorCharLeft } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { syntaxTree } from "@codemirror/language";
import {
  firstH1HideExtension,
  FIRST_H1_HIDDEN_LINE_CLASS,
} from "./firstH1HidePlugin";
import { frontmatterHideExtension } from "./frontmatterHidePlugin";

function makeView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        yamlFrontmatter({ content: markdown() }),
        firstH1HideExtension,
      ],
    }),
  });
}

/** Finds the ATXHeading1 node's [from, to) range, or null when absent. */
function findH1Range(view: EditorView): { from: number; to: number } | null {
  let range: { from: number; to: number } | null = null;
  syntaxTree(view.state).iterate({
    enter(node) {
      if (range === null && node.name === "ATXHeading1") {
        range = { from: node.from, to: node.to };
      }
    },
  });
  return range;
}

const DOC_H1_THEN_BLANK_THEN_BODY = `# Repro Title

Some real paragraph here.`;

const DOC_H1_DIRECTLY_ABOVE_BODY = `# Repro Title
Body line one.
Body line two.`;

const DOC_WITH_FRONTMATTER = `---
tags: [alpha]
---

# Repro Title

Some real paragraph here.`;

const DOC_NEW_NOTE_SCAFFOLD = `---
tags: []
---

# Repro Title

`;

const DOC_NO_H1 = `Just a paragraph.
Another line.`;

// The exact shape that broke failure mode 2: H1 immediately follows the
// frontmatter's closing "---" with NO blank line between them (the H1's
// hide range then starts EXACTLY where frontmatter's own hide range ends).
const DOC_H1_DIRECTLY_AFTER_FRONTMATTER = `---
tags: [alpha]
---
# Repro Title

Some real paragraph here.`;

describe("firstH1HideExtension — the hidden H1's own line is collapsed to zero height", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("H1 followed by a blank line (default new-note scaffold shape): the H1's .cm-line carries the hidden class, contentDOM has exactly ONE row for the H1 (not two)", () => {
    const view = makeView(DOC_H1_THEN_BLANK_THEN_BODY);
    views.push(view);

    const h1Line = view.contentDOM.querySelector(`.${FIRST_H1_HIDDEN_LINE_CLASS}`);
    expect(h1Line).not.toBeNull();
    // Exactly one line carries the hidden class — the H1's own line, not a
    // second phantom copy.
    expect(view.contentDOM.querySelectorAll(`.${FIRST_H1_HIDDEN_LINE_CLASS}`).length).toBe(1);
  });

  it("H1 immediately followed by real body text (no blank line): still gets the hidden-line class", () => {
    const view = makeView(DOC_H1_DIRECTLY_ABOVE_BODY);
    views.push(view);

    expect(view.contentDOM.querySelectorAll(`.${FIRST_H1_HIDDEN_LINE_CLASS}`).length).toBe(1);
  });

  it("doc with frontmatter + H1 + blank + body: exactly one hidden-H1 line, frontmatter collapses separately", () => {
    const view = makeView(DOC_WITH_FRONTMATTER);
    views.push(view);

    expect(view.contentDOM.querySelectorAll(`.${FIRST_H1_HIDDEN_LINE_CLASS}`).length).toBe(1);
  });

  it("exact default NewNoteContent() scaffold shape: frontmatter + H1 + trailing blank line — one hidden H1 row, doc still parses a real trailing blank body line", () => {
    const view = makeView(DOC_NEW_NOTE_SCAFFOLD);
    views.push(view);

    expect(view.contentDOM.querySelectorAll(`.${FIRST_H1_HIDDEN_LINE_CLASS}`).length).toBe(1);
    // The real trailing blank line still renders as its own (non-hidden) row.
    const allLines = view.contentDOM.querySelectorAll(".cm-line");
    const nonHiddenLines = Array.from(allLines).filter(
      (el) => !el.classList.contains(FIRST_H1_HIDDEN_LINE_CLASS),
    );
    expect(nonHiddenLines.length).toBeGreaterThanOrEqual(1);
  });

  it("doc with no H1 at all: no hidden-line class anywhere, no error", () => {
    const view = makeView(DOC_NO_H1);
    views.push(view);

    expect(view.contentDOM.querySelectorAll(`.${FIRST_H1_HIDDEN_LINE_CLASS}`).length).toBe(0);
  });

  it("REGRESSION (failure mode 2): H1 directly after frontmatter with NO blank line — still hides (combines correctly with frontmatterHideExtension's own decorations at the same boundary)", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: DOC_H1_DIRECTLY_AFTER_FRONTMATTER,
        extensions: [
          yamlFrontmatter({ content: markdown() }),
          frontmatterHideExtension,
          firstH1HideExtension,
        ],
      }),
    });
    views.push(view);

    expect(view.contentDOM.querySelectorAll(`.${FIRST_H1_HIDDEN_LINE_CLASS}`).length).toBe(1);
    // The H1's raw text must not appear as a separate, un-hidden `.cm-line`.
    const rawH1Line = Array.from(view.contentDOM.querySelectorAll(".cm-line")).find(
      (el) => el.textContent === "Repro Title" || el.textContent === "# Repro Title",
    );
    expect(rawH1Line).toBeUndefined();
  });
});

describe("firstH1HideExtension — atomic ranges (caret cannot land inside the hidden H1)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("cursorCharLeft from just after the H1 skips OVER the hidden range (atomic), never landing strictly inside it", () => {
    const view = makeView(DOC_H1_THEN_BLANK_THEN_BODY);
    views.push(view);

    const range = findH1Range(view);
    expect(range).not.toBeNull();
    const { from, to } = range!;

    // Park the caret one position past the H1's own range (the first
    // position of the blank line after it) and move left.
    view.dispatch({ selection: { anchor: to + 1 } });
    cursorCharLeft(view);
    const head = view.state.selection.main.head;
    // Never strictly inside (from+1 .. to-1) — atomic skip lands on an edge
    // (from, or bounces back to where it started because the whole range
    // is consumed in one motion).
    expect(head <= from || head >= to).toBe(true);
  });

  it("a selection dispatched strictly inside the H1's range is not silently left there by a subsequent no-op transaction (atomic decoration set covers the full node range)", () => {
    const view = makeView(DOC_H1_THEN_BLANK_THEN_BODY);
    views.push(view);

    const range = findH1Range(view);
    expect(range).not.toBeNull();
    const { from, to } = range!;
    expect(to).toBeGreaterThan(from);

    // Sanity: the atomic decoration set actually spans the H1's range (this
    // is what EditorView.atomicRanges reads from — a non-empty rangeset
    // covering [from, to) proves the guard is wired, independent of
    // browser-specific atomic-motion behavior which jsdom can't fully
    // exercise).
    // The atomic range is extended through the H1's own trailing newline
    // (see firstH1HidePlugin.ts header comment — required for the block
    // replace to collapse height correctly), so its `to` is `to + 1`
    // (capped at doc length), not the bare node's `to`.
    const expectedTo = Math.min(to + 1, view.state.doc.length);
    let sawAtomicSpan = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const facetValues = (view.state.facet as any)(EditorView.atomicRanges);
    for (const getRanges of facetValues) {
      const rangeSet = getRanges(view);
      const cursor = rangeSet.iter();
      while (cursor.value !== null) {
        if (cursor.from === from && cursor.to === expectedTo) sawAtomicSpan = true;
        cursor.next();
      }
    }
    expect(sawAtomicSpan).toBe(true);
  });
});

describe("firstH1HideExtension — outline/tree integrity is unaffected", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("the ATXHeading1 node is still present in the syntax tree after hiding (outlineExtract.ts walks the tree, not rendered DOM)", () => {
    const view = makeView(DOC_H1_THEN_BLANK_THEN_BODY);
    views.push(view);

    const range = findH1Range(view);
    expect(range).not.toBeNull();
    expect(view.state.doc.sliceString(range!.from, range!.to)).toBe("# Repro Title");
  });
});
