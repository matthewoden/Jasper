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
 * Mirrors frontmatterHidePlugin's own successful pattern exactly: a
 * `Decoration.replace({widget, block: true})` over a range that spans
 * THROUGH the line's own trailing newline (ending at the START of the next
 * line, not at the H1 node's own `.to`). Two earlier approaches were tried
 * and rejected — both discovered via a real Phase 31 UAT round-2 bug
 * ("ArrowUp from the top of the body doesn't reach the title"):
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
 *
 * The fix used here avoids both failure modes: extending the SAME
 * `Decoration.replace({widget, block: true})` range through the trailing
 * newline (so it behaves like frontmatter's own multi-line collapse, not a
 * partial single-line one) reliably collapses height AND reliably combines
 * with frontmatterHidePlugin's decorations regardless of adjacency.
 *
 * Adding this does NOT affect outlineExtract.ts: the syntax tree is
 * derived from the document's TEXT, never from rendered decorations, so
 * the heading node stays fully visible to tree-walking code either way.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { StateField, RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Transaction, Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/** CSS class kept for test/introspection purposes — no longer drives hiding directly (see header comment). */
export const FIRST_H1_HIDDEN_LINE_CLASS = "cm-first-h1-hidden";

/**
 * H1EmptyWidget — invisible <span> that takes zero visual space, mirroring
 * frontmatterHidePlugin's FrontmatterEmptyWidget.
 */
class H1EmptyWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.setAttribute("aria-hidden", "true");
    span.style.display = "none";
    span.className = FIRST_H1_HIDDEN_LINE_CLASS;
    return span;
  }

  eq(other: WidgetType): boolean {
    return other instanceof H1EmptyWidget;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(state);
  let done = false;

  tree.iterate({
    enter(node) {
      if (done || node.name !== "ATXHeading1") return;
      done = true;
      // Extend through the line's own trailing newline (up to the START of
      // the next line) so the replace spans a COMPLETE line the same way
      // frontmatterHidePlugin's multi-line block does — required for CM6 to
      // collapse the row to zero height (see header comment, failure mode 1).
      // Capped at doc length for a doc-final H1 with no following newline.
      const end = Math.min(node.to + 1, state.doc.length);
      builder.add(
        node.from,
        end,
        Decoration.replace({ widget: new H1EmptyWidget(), block: true }),
      );
    },
  });

  return builder.finish();
}

const firstH1DecoField = StateField.define<{ decos: DecorationSet }>({
  create(state) {
    return { decos: buildDecorations(state) };
  },
  update(prev, tr: Transaction) {
    if (tr.docChanged) {
      return { decos: buildDecorations(tr.state) };
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
