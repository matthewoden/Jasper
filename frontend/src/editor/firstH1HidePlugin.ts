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
 * No widget is used (unlike frontmatterHidePlugin's FrontmatterEmptyWidget)
 * — the node itself must remain in the syntax tree so outlineExtract.ts
 * (which walks the tree, not the rendered DOM) still sees the heading.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view";
import { StateField, RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Transaction, Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

function buildDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(state);
  let done = false;

  tree.iterate({
    enter(node) {
      if (done || node.name !== "ATXHeading1") return;
      done = true;
      builder.add(node.from, node.to, Decoration.replace({ block: true }));
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
 * firstH1HideExtension — hides the first ATX H1 line's rendered DOM.
 * The heading remains in the syntax tree (outline, onH1Change, save path
 * all keep working unchanged); only the CM6-rendered line is suppressed.
 */
export const firstH1HideExtension: Extension = [firstH1DecoField];
