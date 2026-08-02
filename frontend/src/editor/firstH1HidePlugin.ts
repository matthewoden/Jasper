/**
 * firstH1HidePlugin hides the document's first ATX H1; TitleElement renders it
 * above the editor instead (READ-01).
 *
 * ATX only — hiding a Setext H1 that TitleElement cannot read or write would
 * strand the user with an invisible, uneditable heading.
 *
 * Two things look removable and are not: the replace range must extend THROUGH
 * the trailing newline (CM6 only zero-heights a complete line), and it must stay
 * WIDGET-LESS (a second WidgetType block-replace desyncs CM6's DOM from
 * view.state.doc during live typing, so edits vanish and onH1Change never fires).
 *
 * Block decorations must come from a StateField, not a ViewPlugin.
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
 * firstH1AtomicRanges keeps the caret from parking inside the hidden range.
 * Without it a click where the H1 used to be resolves one document line away
 * from firstVisibleBodyLine()'s target, and ArrowUp never reaches the title.
 */
const firstH1AtomicRanges = EditorView.atomicRanges.of(
  (view) => view.state.field(firstH1DecoField).decos,
);

/**
 * firstH1SelectionClamp catches what firstH1AtomicRanges cannot: atomic ranges
 * only guard INCREMENTAL motion, so an absolute selection — a click via
 * posAtCoords, a programmatic jump — still resolves inside the collapsed
 * preamble. Clicking the visual gap above the first rendered line is exactly
 * that, and is why Delete/Backspace appeared to do nothing there.
 *
 * Selections extending PAST the boundary (select-all) pass through untouched.
 *
 * The no-H1 fast-gate is required, not defensive. firstVisibleBodyLine() falls
 * back to the frontmatter boundary, whose merge-line skip then eats a real
 * user-authored blank line and shifts every later selection forward — observed
 * corrupting saved content via Control+Home on a note with no H1. With no H1,
 * frontmatterSelectionClamp already owns that boundary correctly.
 */
const firstH1SelectionClamp = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection) return tr;
  if (!findFirstH1Range(tr.state)) return tr;
  const target = firstVisibleBodyLine(tr.state);
  const boundary = target ? target.from : tr.state.doc.length;
  const main = tr.newSelection.main;
  if (main.anchor >= boundary || main.head >= boundary) return tr;
  return [tr, { selection: { anchor: boundary } }];
});

/**
 * guardHiddenFirstH1Delete blocks a Backspace/Delete that would consume the
 * hidden H1 whole — CM6's delete commands swallow an atomic range entirely when
 * naive motion would land inside one, which would erase the title. It only ever
 * blocks; ArrowUp (titleBodyTraversal.ts) owns crossing to the title.
 *
 * The extends-past carve-out is not optional: a non-empty selection reaching at
 * or past the boundary is a legitimate broader edit. Without it, select-all +
 * Delete was silently swallowed on any note whose H1 is followed by more
 * heading-shaped content, leaving everything selected so the next keystroke
 * replaced the whole document, title included.
 */
function guardHiddenFirstH1Delete(view: EditorView, forward: boolean): boolean {
  if (!findFirstH1Range(view.state)) return false;

  const target = firstVisibleBodyLine(view.state);
  const boundary = target ? target.from : view.state.doc.length;

  const { main } = view.state.selection;
  if (!main.empty) return main.to <= boundary;
  return forward ? main.head < boundary : main.head <= boundary;
}

/**
 * Place in the same extensions slot as frontmatterBackspaceGuardKeymap, before
 * defaultKeymap. The two compose: each guards its own boundary, and a delete
 * past both falls through in either order.
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
