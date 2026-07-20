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
import { EditorState, StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import type { Transaction, Extension } from "@codemirror/state";
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


/** Returns the frontmatter node's `.to` boundary, or null when the doc has none. */
function frontmatterBoundary(state: EditorState): number | null {
  let boundary: number | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === FRONTMATTER_NODE_NAME) boundary = node.to;
    },
  });
  return boundary;
}


/**
 * frontmatterAtomicRanges — while hidden, the replaced block is atomic so
 * cursor-motion commands can never place the caret strictly inside it
 * (WR-03: an inside caret let Backspace/Delete/typing silently mutate the
 * invisible YAML one keystroke past the boundary guard).
 */
const frontmatterAtomicRanges = EditorView.atomicRanges.of((view) => {
  const { hidden, decos } = view.state.field(frontmatterDecoField);
  return hidden ? decos : Decoration.none;
});


/**
 * frontmatterHiddenEditFilter — drops user-initiated (input/delete/move)
 * changes that fall ENTIRELY inside the hidden block, e.g. a caret restored
 * inside programmatically and then typed at. Changes that extend past the
 * boundary (select-all replace) and non-user programmatic changes
 * (server-driven rewrites, note-switch doc swaps) pass through untouched.
 */
const frontmatterHiddenEditFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (!tr.isUserEvent("input") && !tr.isUserEvent("delete") && !tr.isUserEvent("move")) return tr;
  if (!tr.startState.field(frontmatterDecoField).hidden) return tr;
  const boundary = frontmatterBoundary(tr.startState);
  if (boundary === null) return tr;

  let invisibleEdit = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (fromA < boundary && toA <= boundary) invisibleEdit = true;
  });
  return invisibleEdit ? [] : tr;
});


/**
 * frontmatterHideExtension — full extension set for MarkdownEditor.
 * Combines the StateField (block decorations), the ViewPlugin (test
 * introspection), the atomic range (caret can't enter the hidden block),
 * and the hidden-edit transaction filter.
 */
export const frontmatterHideExtension: Extension = [
  frontmatterDecoField,
  frontmatterHidePlugin,
  frontmatterAtomicRanges,
  frontmatterHiddenEditFilter,
];


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
 * guardHiddenFrontmatterDelete — shared Backspace/Delete guard (D-23, WR-03).
 * With frontmatterAtomicRanges the caret only ever sits on the block's edges
 * (0 or boundary), but CM6's delete commands skip atomic ranges by consuming
 * them WHOLE: Backspace at the boundary or Delete at 0 would silently erase
 * the entire hidden YAML. Also swallows deletes whose selection reaches into
 * the hidden block (Shift-Home from the first body line).
 */
function guardHiddenFrontmatterDelete(view: EditorView, forward: boolean): boolean {
  const { hidden } = view.state.field(frontmatterDecoField);
  if (!hidden) return false;

  const boundary = frontmatterBoundary(view.state);
  if (boundary === null) return false;

  const { main } = view.state.selection;
  if (!main.empty) return main.from < boundary;
  return forward ? main.head < boundary : main.head <= boundary;
}

/**
 * frontmatterBackspaceGuardKeymap — no-ops Backspace/Delete keystrokes that
 * would erase hidden frontmatter (D-23 boundary case plus the WR-03 atomic
 * edge cases); otherwise falls through to defaultKeymap. Place before
 * defaultKeymap (same extensions-array slot as frontmatterToggleKeymap).
 */
export const frontmatterBackspaceGuardKeymap = keymap.of([
  {
    key: "Backspace",
    run: (view: EditorView) => guardHiddenFrontmatterDelete(view, false),
  },
  {
    key: "Delete",
    run: (view: EditorView) => guardHiddenFrontmatterDelete(view, true),
  },
]);
