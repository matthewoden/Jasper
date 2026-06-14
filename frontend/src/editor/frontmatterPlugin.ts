/**
 * frontmatterPlugin — emits Decoration.line with class "cm-frontmatter" over
 * the Frontmatter node produced by yamlFrontmatter({content: markdown()}).
 *
 * The lezer node name is "Frontmatter" (lowercase 'm') — enforced by
 * FRONTMATTER_NODE_NAME to prevent a silent mismatch.
 *
 * IME gate: when view.composing is true, decorations are mapped through
 * u.changes instead of rebuilding to avoid churn during IME input.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";


export const FRONTMATTER_NODE_NAME = "Frontmatter";
export const FRONTMATTER_LINE_CLASS = "cm-frontmatter";

const frontmatterLineDeco = Decoration.line({ class: FRONTMATTER_LINE_CLASS });

export function buildFrontmatterDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  tree.iterate({
    enter(node) {
      if (node.name !== FRONTMATTER_NODE_NAME) return;
      let pos = node.from;
      while (pos < node.to) {
        const line = view.state.doc.lineAt(pos);
        builder.add(line.from, line.from, frontmatterLineDeco);
        if (line.to >= node.to) break;
        pos = line.to + 1;
      }
    },
  });
  return builder.finish();
}

export const frontmatterPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildFrontmatterDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.view.composing) {
        this.decorations = this.decorations.map(u.changes);
        return;
      }
      if (
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = buildFrontmatterDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);
