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
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import { EditorState, StateField, RangeSetBuilder } from "@codemirror/state";
import type { Transaction, Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { firstVisibleBodyLine } from "./titleBodyTraversal";

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
 * firstH1SelectionClamp — mirrors frontmatterHidePlugin.ts's own
 * frontmatterSelectionClamp, but keyed off firstVisibleBodyLine()
 * (titleBodyTraversal.ts) rather than this H1's own boundary alone: that
 * helper already computes the boundary past BOTH hidden regions (frontmatter
 * + this hidden H1) plus the CM6 "merge line" rendering artifact documented
 * at the top of this file (an immediately-following blank line gets folded
 * into the H1's own hidden block and never renders its own `.cm-line`).
 * firstH1AtomicRanges only guards INCREMENTAL cursor motion (arrow keys,
 * word-jumps) — an absolute selection set directly (a mouse click via
 * posAtCoords, or a programmatic jump) can still resolve inside the
 * collapsed preamble. Clicking in the visual gap between the title and body
 * is exactly this case: the click Y-coordinate falls above the first
 * rendered line, and CM6 resolves it to a position in the collapsed region
 * rather than onto the first VISIBLE line — this is the root cause of the
 * "Delete/Backspace does nothing after clicking the gap" bug (Phase 31 UAT
 * round 4). Clamp any selection that falls ENTIRELY before the boundary out
 * to the boundary itself; selections that extend past it (select-all) pass
 * through untouched, matching frontmatterSelectionClamp's contract exactly.
 */
const firstH1SelectionClamp = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection) return tr;
  const target = firstVisibleBodyLine(tr.state);
  const boundary = target ? target.from : tr.state.doc.length;
  const main = tr.newSelection.main;
  if (main.anchor >= boundary || main.head >= boundary) return tr;
  return [tr, { selection: { anchor: boundary } }];
});

/**
 * guardHiddenFirstH1Delete — Backspace/Delete guard mirroring
 * frontmatterHidePlugin.ts's guardHiddenFrontmatterDelete, but keyed off the
 * SAME combined firstVisibleBodyLine() boundary firstH1SelectionClamp uses
 * above (frontmatter + hidden H1 + merge lines) rather than this H1's own
 * range alone. With firstH1SelectionClamp in place the caret always lands
 * EXACTLY at that boundary after a gap-click, never strictly inside the
 * hidden H1 — but CM6's delete commands still consume an atomic range WHOLE
 * when a Backspace/Delete's naive motion would land inside one: a Backspace
 * at the boundary would otherwise delete the entire hidden H1 (erasing the
 * title); a Delete or selection reaching back into the collapsed preamble
 * would do the same. D-19: Backspace at body-start is a GUARDED NO-OP, not a
 * cross-to-title (ArrowUp, titleBodyTraversal.ts, already owns that
 * gesture) — so this guard only ever blocks, never redirects.
 */
function guardHiddenFirstH1Delete(view: EditorView, forward: boolean): boolean {
  if (!findFirstH1Range(view.state)) return false;

  const target = firstVisibleBodyLine(view.state);
  const boundary = target ? target.from : view.state.doc.length;

  const { main } = view.state.selection;
  if (!main.empty) return main.from < boundary;
  return forward ? main.head < boundary : main.head <= boundary;
}

/**
 * firstH1BackspaceGuardKeymap — no-ops Backspace/Delete keystrokes that
 * would erase the hidden first H1 (see guardHiddenFirstH1Delete above);
 * otherwise falls through to defaultKeymap. Place in the SAME extensions-
 * array slot as frontmatterBackspaceGuardKeymap (before defaultKeymap) —
 * MarkdownEditor.tsx registers both; each guards its own boundary
 * independently and neither interferes with the other (D-19/D-21 compose:
 * whichever boundary the caret is at or before triggers its own guard, and
 * a Delete/Backspace genuinely past BOTH boundaries falls through to normal
 * editing in either order).
 */
export const firstH1BackspaceGuardKeymap = keymap.of([
  {
    key: "Backspace",
    run: (view: EditorView) => guardHiddenFirstH1Delete(view, false),
  },
  {
    key: "Delete",
    run: (view: EditorView) => guardHiddenFirstH1Delete(view, true),
  },
]);

/**
 * firstH1HideExtension — hides the first ATX H1 line's rendered DOM.
 * The heading remains in the syntax tree (outline, onH1Change, save path
 * all keep working unchanged); only the CM6-rendered line is suppressed,
 * and the caret can no longer land inside it (firstH1AtomicRanges covers
 * incremental motion; firstH1SelectionClamp covers absolute jumps/clicks).
 */
export const firstH1HideExtension: Extension = [
  firstH1DecoField,
  firstH1AtomicRanges,
  firstH1SelectionClamp,
];
