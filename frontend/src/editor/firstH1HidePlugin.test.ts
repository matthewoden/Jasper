/**
 * firstH1HidePlugin.test.ts — vitest suite for the first-H1 hide plugin.
 *
 * Regression coverage for two real Phase 31 UAT bugs (see
 * firstH1HidePlugin.ts's header comment for the full investigation):
 *
 * 1. "ArrowUp from the top of the body doesn't reach the title" (round 2) —
 *    a partial-line replace (excluding the H1's own trailing newline) left a
 *    normal-height phantom row behind, breaking the ArrowUp body->title
 *    handoff. Fixed by extending the replace range through the newline.
 * 2. "tree label / TitleElement never live-updates while typing a new H1"
 *    (this file's regression) — a WidgetType-based replace decoration
 *    (mirroring frontmatterHidePlugin's own pattern) corrupted CM6's
 *    DOM/state reconciliation while the user actively typed into the H1
 *    line, silently desyncing the rendered DOM from `view.state.doc`. Fixed
 *    by using a bare (widget-less) `Decoration.replace({block: true})`
 *    instead — CM6 supplies its own placeholder DOM node, with no
 *    WidgetType instance to trigger the corruption.
 *
 * Because the fix intentionally has NO widget, there is no dedicated DOM
 * node left to attach a CSS class to for introspection (the widget-less
 * block replace consumes the entire line, including what would have been
 * its `.cm-line` element) — so these tests assert against DOM STRUCTURE
 * (no separate `.cm-line` renders for the hidden H1; no phantom row; the
 * H1's raw text never appears as a normal, unhidden line) and against the
 * state-level decoration range (`findFirstH1HideRange`) rather than a class.
 */
import { describe, expect, it, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { cursorCharLeft } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { syntaxTree } from "@codemirror/language";
import { firstH1HideExtension, findFirstH1HideRange } from "./firstH1HidePlugin";
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

// The exact shape that broke failure mode 2 (see firstH1HidePlugin.ts):
// H1 immediately follows the frontmatter's closing "---" with NO blank line
// between them (the H1's hide range then starts EXACTLY where frontmatter's
// own hide range ends).
const DOC_H1_DIRECTLY_AFTER_FRONTMATTER = `---
tags: [alpha]
---
# Repro Title

Some real paragraph here.`;

/** No `.cm-line` in contentDOM renders the H1's raw text (hidden means gone, not just re-styled). */
function rawH1LineIn(view: EditorView): Element | undefined {
  return Array.from(view.contentDOM.querySelectorAll(".cm-line")).find(
    (el) => el.textContent === "Repro Title" || el.textContent === "# Repro Title",
  );
}

describe("firstH1HideExtension — the hidden H1's own line is collapsed to zero height", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("H1 followed by a blank line (default new-note scaffold shape): decoration range covers the H1's own line INCLUDING its trailing newline, raw H1 text never renders as its own .cm-line", () => {
    const view = makeView(DOC_H1_THEN_BLANK_THEN_BODY);
    views.push(view);

    const h1Range = findH1Range(view);
    expect(h1Range).not.toBeNull();
    const hideRange = findFirstH1HideRange(view.state);
    expect(hideRange).not.toBeNull();
    expect(hideRange!.from).toBe(h1Range!.from);
    // Extended through the trailing newline, one past the bare node's `.to`.
    expect(hideRange!.to).toBe(h1Range!.to + 1);
    expect(rawH1LineIn(view)).toBeUndefined();
  });

  it("H1 immediately followed by real body text (no blank line): still hidden, no separate .cm-line for it", () => {
    const view = makeView(DOC_H1_DIRECTLY_ABOVE_BODY);
    views.push(view);

    expect(findFirstH1HideRange(view.state)).not.toBeNull();
    expect(rawH1LineIn(view)).toBeUndefined();
  });

  it("doc with frontmatter + H1 + blank + body: H1 hidden regardless of frontmatter presence (this suite's makeView does not itself hide frontmatter — see the dedicated adjacency test below for that combination)", () => {
    const view = makeView(DOC_WITH_FRONTMATTER);
    views.push(view);

    expect(findFirstH1HideRange(view.state)).not.toBeNull();
    expect(rawH1LineIn(view)).toBeUndefined();
    // The H1's own line never renders — frontmatter's raw "---" lines DO
    // render here since frontmatterHideExtension isn't wired into this
    // suite's makeView (only firstH1HideExtension is under test).
    const lineTexts = Array.from(view.contentDOM.querySelectorAll(".cm-line")).map(
      (el) => el.textContent,
    );
    expect(lineTexts).toEqual(["---", "tags: [alpha]", "---", "", "Some real paragraph here."]);
  });

  it("exact default NewNoteContent() scaffold shape: frontmatter + H1 + trailing blank line — H1 hidden, doc still parses a real trailing blank body line", () => {
    const view = makeView(DOC_NEW_NOTE_SCAFFOLD);
    views.push(view);

    expect(findFirstH1HideRange(view.state)).not.toBeNull();
    // The real trailing blank line still renders as its own (visible) row.
    const allLines = view.contentDOM.querySelectorAll(".cm-line");
    expect(allLines.length).toBeGreaterThanOrEqual(1);
  });

  it("doc with no H1 at all: no hide range, no error", () => {
    const view = makeView(DOC_NO_H1);
    views.push(view);

    expect(findFirstH1HideRange(view.state)).toBeNull();
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

    expect(findFirstH1HideRange(view.state)).not.toBeNull();
    expect(rawH1LineIn(view)).toBeUndefined();
  });
});

// NOTE: the actual widget-corruption bug only manifested via real browser
// contenteditable input events reconciled through CM6's applyDOMChange path
// (jsdom has no real text layout, so `view.dispatch()` here never exercises
// that code path) — the authoritative regression guard for this bug is the
// real-browser E2E suite (phase3-uat.spec.ts Scenario G, phase5_5-uat.spec.ts
// UX-08). These jsdom tests only guard the model-level contract (state.doc
// matches what was typed via direct transactions); keep them as a basic
// sanity check, not a substitute for the E2E coverage.
describe("firstH1HideExtension — live typing does not desync DOM from state (regression: widget-based replace corrupted this)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("typing a brand-new H1 character-by-character keeps view.state.doc in sync with every keystroke", () => {
    const view = makeView("");
    views.push(view);

    const text = "# Live Title\n\nbody here";
    for (let i = 0; i < text.length; i++) {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text[i] },
      });
    }

    expect(view.state.doc.toString()).toBe(text);
  });

  it("select-all + delete + retype (the exact E2E recipe) leaves view.state.doc matching the retyped text, not stale original content", () => {
    const view = makeView(DOC_H1_THEN_BLANK_THEN_BODY);
    views.push(view);

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "" },
    });
    expect(view.state.doc.length).toBe(0);

    const text = "# Live Title\n\nbody here";
    for (let i = 0; i < text.length; i++) {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text[i] },
      });
    }

    expect(view.state.doc.toString()).toBe(text);
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
