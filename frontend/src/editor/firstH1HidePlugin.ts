/**
 * firstH1HidePlugin — CM6 extension that visually hides the document's
 * FIRST ATX H1 line (the doc's title, now rendered above the editor by
 * TitleElement — READ-01/D-01/D-02).
 *
 * Scoped to `ATXHeading1` only — underline-style ("Setext") H1 nodes are
 * deliberately NOT matched: TitleElement, onH1Change, and h1Extract.ts all
 * detect ATX-only H1s (`/^# (.+)$/m`, `trimmed.startsWith("# ")`); hiding
 * an underline-style H1 the title element can't read/write would strand
 * the user with an invisible, uneditable heading.
 *
 * Block decorations must come from a StateField, not a ViewPlugin (CM6
 * constraint: "Block decorations may not be specified via plugins").
 *
 * The replace range spans THROUGH the line's own trailing newline (ending
 * at the START of the next line, not at the H1 node's own `.to`). Three
 * approaches were tried, in order, all discovered via real Phase 31 UAT bugs:
 *
 * 1. A bare `Decoration.replace({block: true})` over just the H1 NODE's own
 *    range (node.from..node.to, EXCLUDING its trailing newline) hides the
 *    TEXT but the line's own `.cm-line` row still renders at normal
 *    line-height in a real browser — CM6 only collapses a replaced range to
 *    zero height when it spans a COMPLETE line including its own newline
 *    (as frontmatterHidePlugin's block already does, spanning multiple full
 *    lines); a partial-line replace leaves an empty-but-normal-height row
 *    behind. That phantom row appears whenever the H1 is followed by a
 *    blank line — which is BOTH the default new-note scaffold
 *    (NewNoteContent) and the ordinary title-blank-line-body convention —
 *    and is indistinguishable from real blank body space while remaining
 *    fully mouse/caret-accessible, breaking the ArrowUp title-crossing
 *    keymap's `curLine.number !== target.number` guard (titleBodyTraversal.ts).
 * 2. A `Decoration.line({class: ...})` styled `display: none` DOES collapse
 *    height correctly in isolation, but silently fails to apply AT ALL
 *    (confirmed via jsdom + real-browser repro) whenever the decorated
 *    line's `.from` position is EXACTLY where frontmatterHidePlugin's own
 *    block-replace decoration ends (i.e. the H1 immediately follows the
 *    frontmatter with no blank line between them — also a common shape).
 *    CM6 does not combine a zero-length line decoration positioned exactly
 *    at another source's block-replace boundary reliably.
 * 3. A `Decoration.replace({widget, block: true})` — mirroring
 *    frontmatterHidePlugin's own FrontmatterEmptyWidget pattern exactly —
 *    DOES collapse height correctly AND combines fine with frontmatter's own
 *    decorations, BUT it corrupts live typing: while the user is actively
 *    typing INTO the still-being-recognized H1 line (e.g. immediately after
 *    a select-all+retype), the widget-based replace decoration + this same
 *    range marked atomic (firstH1AtomicRanges) causes CM6's DOM/state
 *    reconciliation for the in-progress edit to desync from its own model —
 *    the rendered DOM shows the freshly typed heading as a normal (unhidden)
 *    line while `view.state.doc` silently keeps the note's ORIGINAL
 *    pre-edit content. onH1Change / the tree's live label then never fires
 *    for the real edit (phase3-uat.spec.ts Scenario G, phase5_5-uat.spec.ts
 *    UX-08 — Phase 31 UAT round-2 regression). Confirmed via isolated
 *    real-browser repro: removing ONLY the widget — keeping the
 *    newline-extended range AND firstH1AtomicRanges exactly as coded for the
 *    ArrowUp fix below — resolves the corruption; the widget itself, not the
 *    range extension or the atomic marking, was the culprit (a second
 *    WidgetType-based block-replace instance alongside frontmatter's own,
 *    both recomputed on every keystroke, is what CM6's view/state
 *    reconciliation cannot handle reliably here).
 *
 * The fix used here is #1's bare `Decoration.replace({block: true})` (no
 * widget — CM6 supplies its own zero-height placeholder DOM node for a
 * widget-less block replace) extended through the trailing newline like
 * frontmatter's own multi-line collapse (avoiding failure mode 1), plus
 * firstH1AtomicRanges (below) for the ArrowUp fix — without introducing a
 * second WidgetType instance alongside frontmatter's own (avoiding failure
 * mode 3). A widget-less block replace renders NO `.cm-line` for the hidden
 * range at all (it is fully consumed by the replace) — so there is no DOM
 * node left to attach a CSS class to; `findFirstH1HideRange` below exposes
 * the exact [from, to) range the state-level decoration covers so
 * test/introspection code can assert against the model directly instead.
 *
 * Adding this does NOT affect outlineExtract.ts: the syntax tree is
 * derived from the document's TEXT, never from rendered decorations, so
 * the heading node stays fully visible to tree-walking code either way.
 */
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { StateField, RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Transaction, Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/** Finds the first ATXHeading1 node's [from, to) range, or null when absent. */
function findFirstH1Range(state: EditorState): { from: number; to: number } | null {
  let range: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (range === null && node.name === "ATXHeading1") {
        range = { from: node.from, to: node.to };
      }
    },
  });
  return range;
}

/**
 * findFirstH1HideRange — the exact [from, to) range firstH1DecoField hides
 * (the H1 node extended through its own trailing newline), or null when the
 * doc has no first H1. Exported for test/introspection use only (see header
 * comment) — production code never needs this; onH1Change/h1Extract.ts read
 * the doc's TEXT, not this decoration range.
 */
export function findFirstH1HideRange(state: EditorState): { from: number; to: number } | null {
  const range = findFirstH1Range(state);
  if (!range) return null;
  return { from: range.from, to: Math.min(range.to + 1, state.doc.length) };
}

function buildHideDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const range = findFirstH1Range(state);
  if (range) {
    // Extend through the line's own trailing newline (up to the START of
    // the next line) so the replace spans a COMPLETE line the same way
    // frontmatterHidePlugin's multi-line block does — required for CM6 to
    // collapse the row to zero height (see header comment, failure mode 1).
    // Capped at doc length for a doc-final H1 with no following newline.
    const end = Math.min(range.to + 1, state.doc.length);
    builder.add(range.from, end, Decoration.replace({ block: true }));
  }
  return builder.finish();
}

const firstH1DecoField = StateField.define<{ decos: DecorationSet }>({
  create(state) {
    return { decos: buildHideDecorations(state) };
  },
  update(prev, tr: Transaction) {
    if (tr.docChanged) {
      return { decos: buildHideDecorations(tr.state) };
    }
    return { decos: prev.decos.map(tr.changes) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

/**
 * firstH1AtomicRanges — the hidden H1's replaced range (including its
 * trailing newline) is atomic so mouse clicks (posAtCoords) and keyboard
 * vertical/horizontal motion can never park the caret strictly inside it —
 * mirrors frontmatterHidePlugin's frontmatterAtomicRanges. Without this, a
 * click landing where the hidden H1 line used to be could still resolve to
 * a position inside it, one document line away from
 * firstVisibleBodyLine()'s target — the actual root cause of the
 * ArrowUp-doesn't-reach-title bug (Phase 31 UAT round 2).
 */
const firstH1AtomicRanges = EditorView.atomicRanges.of(
  (view) => view.state.field(firstH1DecoField).decos,
);

/**
 * firstH1HideExtension — hides the first ATX H1 line's rendered DOM.
 * The heading remains in the syntax tree (outline, onH1Change, save path
 * all keep working unchanged); only the CM6-rendered line is suppressed,
 * and the caret can no longer land inside it (firstH1AtomicRanges).
 */
export const firstH1HideExtension: Extension = [
  firstH1DecoField,
  firstH1AtomicRanges,
];
