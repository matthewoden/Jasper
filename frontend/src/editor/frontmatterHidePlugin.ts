/**
 * frontmatterHidePlugin — CM6 extension that hides the YAML frontmatter block
 * by default, replacing it with an invisible empty widget (zero visible UI).
 * Cmd-Shift-Y toggles between hidden and raw YAML view.
 *
 * Block decorations must come from a StateField, not a ViewPlugin (CM6
 * constraint: "Block decorations may not be specified via plugins"). The
 * StateField holds `{ hidden: boolean; decos: DecorationSet }` and rebuilds
 * on `toggleFrontmatterVisibility` effect or doc change.
 *
 * When hidden=false (raw view), only line decorations are applied — no
 * Decoration.replace — to avoid cursor-position mismatch from multi-line replaces.
 *
 * The ViewPlugin is a thin shim that exposes `decorations` for test introspection
 * via `view.plugin()`.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  keymap,
} from "@codemirror/view";
import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Transaction, Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { FRONTMATTER_NODE_NAME, FRONTMATTER_LINE_CLASS } from "./frontmatterPlugin";


/** Toggles the frontmatter hidden state when dispatched. */
export const toggleFrontmatterVisibility = StateEffect.define<void>();


/**
 * countTagsInFrontmatter — counts tags in a YAML frontmatter block.
 * Supports flow-sequence (`tags: [foo, bar]`) and block-sequence
 * (`tags:\n  - foo`) forms. Count is presentational; off-by-one is acceptable.
 *
 * @param text - The raw frontmatter block text (from --- to ---)
 * @returns number of tags (0 if no tags key found or empty array)
 */
export function countTagsInFrontmatter(text: string): number {
  const flowMatch = text.match(/\btags\s*:\s*\[([^\]]*)\]/);
  if (flowMatch) {
    const inner = flowMatch[1].trim();
    if (!inner) return 0;
    return inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0).length;
  }

  const blockMatch = text.match(/\btags\s*:\s*\n((?:[ \t]*-[ \t]+[^\n]+\n?)*)/);
  if (blockMatch) {
    const block = blockMatch[1];
    return (block.match(/^[ \t]*-[ \t]+[^\s]/gm) ?? []).length;
  }

  return 0;
}


/**
 * FrontmatterEmptyWidget — invisible <span> that takes zero visual space.
 * aria-hidden="true" + display:none keeps the frontmatter block fully hidden.
 */
class FrontmatterEmptyWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.setAttribute("aria-hidden", "true");
    span.style.display = "none";
    return span;
  }

  eq(other: WidgetType): boolean {
    return other instanceof FrontmatterEmptyWidget;
  }

  ignoreEvent(): boolean {
    return true;
  }
}


interface FrontmatterFieldState {
  /** Whether the frontmatter is currently hidden (affordance shown). */
  hidden: boolean;
  /** The current decoration set. */
  decos: DecorationSet;
}


const frontmatterLineDeco = Decoration.line({ class: FRONTMATTER_LINE_CLASS });

function buildDecorations(state: EditorState, hidden: boolean): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(state);

  tree.iterate({
    enter(node) {
      if (node.name !== FRONTMATTER_NODE_NAME) return;

      if (hidden) {
        builder.add(
          node.from,
          node.to,
          Decoration.replace({
            widget: new FrontmatterEmptyWidget(),
            block: true,
          }),
        );
      } else {
        let pos = node.from;
        while (pos < node.to) {
          const line = state.doc.lineAt(pos);
          builder.add(line.from, line.from, frontmatterLineDeco);
          if (line.to >= node.to) break;
          pos = line.to + 1;
        }
      }
    },
  });

  return builder.finish();
}


/**
 * frontmatterDecoField — StateField holding `{ hidden, decos }`.
 * Block decorations must come from a StateField (CM6 constraint).
 * Starts hidden=true; flips on toggleFrontmatterVisibility.
 */
const frontmatterDecoField = StateField.define<FrontmatterFieldState>({
  create(state) {
    const decos = buildDecorations(state, true);
    return { hidden: true, decos };
  },
  update(prev, tr: Transaction) {
    const hasToggle = tr.effects.some((e) => e.is(toggleFrontmatterVisibility));
    if (hasToggle) {
      const newHidden = !prev.hidden;
      return { hidden: newHidden, decos: buildDecorations(tr.state, newHidden) };
    }
    if (tr.docChanged) {
      return { hidden: prev.hidden, decos: buildDecorations(tr.state, prev.hidden) };
    }
    return { hidden: prev.hidden, decos: prev.decos.map(tr.changes) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});


/**
 * frontmatterHidePlugin — thin ViewPlugin shim.
 * Exposes `decorations` for test introspection via `view.plugin(frontmatterHidePlugin)`.
 * Block decorations are provided by frontmatterDecoField (StateField), not here.
 */
export const frontmatterHidePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = view.state.field(frontmatterDecoField).decos;
    }

    update(u: ViewUpdate) {
      if (u.view.composing) {
        this.decorations = this.decorations.map(u.changes);
        return;
      }
      this.decorations = u.view.state.field(frontmatterDecoField).decos;
    }
  },
  { decorations: (v) => v.decorations },
);


/**
 * frontmatterHideExtension — full extension set for MarkdownEditor.
 * Combines the StateField (block decorations) and the ViewPlugin (test introspection).
 */
export const frontmatterHideExtension: Extension = [frontmatterDecoField, frontmatterHidePlugin];


/** CM6 keymap binding for Cmd-Shift-Y (Mod-Shift-y). Place before defaultKeymap. */
export const frontmatterToggleKeymap = keymap.of([
  {
    key: "Mod-Shift-y",
    preventDefault: true,
    run(view: EditorView): boolean {
      view.dispatch({ effects: toggleFrontmatterVisibility.of(undefined) });
      return true;
    },
  },
]);


/**
 * frontmatterBackspaceGuardKeymap — swallows Backspace at the hidden-frontmatter
 * boundary (D-23). `frontmatterDecoField`'s Decoration.replace hides the block
 * visually but registers no atomicRanges, so CM6's default deleteCharBackward
 * deletes the last raw character of the hidden block. This guard no-ops the
 * keystroke when hidden=true, selection is empty, and head sits exactly at the
 * frontmatter node's `.to` boundary; otherwise it falls through to defaultKeymap.
 * Place before defaultKeymap (same extensions-array slot as frontmatterToggleKeymap).
 */
export const frontmatterBackspaceGuardKeymap = keymap.of([
  {
    key: "Backspace",
    run(view: EditorView): boolean {
      const { hidden } = view.state.field(frontmatterDecoField);
      if (!hidden) return false;

      let boundary: number | null = null;
      syntaxTree(view.state).iterate({
        enter(node) {
          if (node.name === FRONTMATTER_NODE_NAME) boundary = node.to;
        },
      });

      const { main } = view.state.selection;
      if (boundary !== null && main.empty && main.head === boundary) {
        return true;
      }
      return false;
    },
  },
]);
