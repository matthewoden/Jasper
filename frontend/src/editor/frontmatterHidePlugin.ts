/**
 * frontmatterHidePlugin — CM6 extension that hides the YAML frontmatter block
 * by default, replacing it with an invisible empty widget (zero visible UI).
 *
 * Phase 6.6 / UX-CHROME-05 / Plan 06.6-03
 * Reverses Phase 6.5 D-12 ("thin affordance preferred") per Phase 6.6 D-16/D-18.
 * UAT confirmed the affordance added clutter now that inline #tagname rendering
 * is the user's mental model.
 *
 * Design decisions:
 *   - D-16: Frontmatter block renders ZERO visible UI when hidden.
 *   - D-17: Cmd-Shift-Y (D-13 escape hatch) is the only way to view raw YAML.
 *   - D-18: Empty widget uses aria-hidden="true" + display:none.
 *
 * Architecture — StateField for block decorations:
 *   CM6 enforces "Block decorations may not be specified via plugins"
 *   (ViewPlugin cannot emit block:true decorations). We use a StateField to
 *   hold both the `hidden` boolean and the computed DecorationSet.
 *
 *   The StateField stores `{ hidden: boolean; decos: DecorationSet }`.
 *   On `toggleFrontmatterVisibility` effect, it flips `hidden` and rebuilds.
 *   `EditorView.decorations.from(field, f => f.decos)` provides the decorations
 *   to CM6's rendering pipeline.
 *
 *   The ViewPlugin is a thin shim that:
 *     1. Resets the StateField to `hidden=true` on first mount (D-17 reset).
 *     2. Exposes `decorations` for test introspection via `view.plugin()`.
 *
 * Cursor safety (Pitfall 1): When `hidden=false` (raw view), NO
 * Decoration.replace is applied — only line decorations. This prevents
 * cursor-position mismatch artifacts from multi-line replaces.
 *
 * v1 limitation (T-06.5-19): StateField hidden state is per-EditorState —
 * each new EditorView gets its own fresh EditorState, so the reset-to-hidden
 * behavior is correctly per-mount. No shared mutable module-level state
 * for the hidden boolean in this implementation.
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

// ---------------------------------------------------------------------------
// StateEffect — toggle signal
// ---------------------------------------------------------------------------

/**
 * Dispatching this effect from anywhere (keymap, button click) toggles
 * the frontmatter hidden state.
 *
 * Usage:
 *   view.dispatch({ effects: toggleFrontmatterVisibility.of(undefined) });
 */
export const toggleFrontmatterVisibility = StateEffect.define<void>();

// ---------------------------------------------------------------------------
// Tag count helper
// ---------------------------------------------------------------------------

/**
 * Counts the number of tags in a YAML frontmatter text block.
 *
 * Supports both flow-sequence syntax (`tags: [foo, bar]`) and
 * block-sequence syntax (`tags:\n  - foo\n  - bar`).
 *
 * This count is purely presentational — an off-by-one is acceptable.
 * Output is a Number, never a user-controlled string (T-06.5-17).
 *
 * @param text - The raw frontmatter block text (from --- to ---)
 * @returns number of tags (0 if no tags key found or empty array)
 */
export function countTagsInFrontmatter(text: string): number {
  // Try flow-sequence: tags: [foo, bar, baz]
  const flowMatch = text.match(/\btags\s*:\s*\[([^\]]*)\]/);
  if (flowMatch) {
    const inner = flowMatch[1].trim();
    if (!inner) return 0;
    return inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0).length;
  }

  // Try block-sequence: tags:\n  - tagname
  const blockMatch = text.match(/\btags\s*:\s*\n((?:[ \t]*-[ \t]+[^\n]+\n?)*)/);
  if (blockMatch) {
    const block = blockMatch[1];
    return (block.match(/^[ \t]*-[ \t]+[^\s]/gm) ?? []).length;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// WidgetType — empty invisible widget (D-16/D-18)
// ---------------------------------------------------------------------------

/**
 * FrontmatterEmptyWidget renders an invisible <span> that takes zero visual
 * space. The frontmatter YAML block is fully hidden from the editor by default.
 *
 * D-16: Zero visible UI — no button, no label, no chevron.
 * D-18: aria-hidden="true" + display:none for accessibility and layout.
 *
 * Note: The `.cm-frontmatter-affordance` CSS selector in theme.css becomes
 * dead code after this change. Flag for Wave 5 cleanup (or leave in place
 * as harmless — no DOM elements will ever match it).
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

// ---------------------------------------------------------------------------
// StateField value type
// ---------------------------------------------------------------------------

interface FrontmatterFieldState {
  /** Whether the frontmatter is currently hidden (affordance shown). */
  hidden: boolean;
  /** The current decoration set. */
  decos: DecorationSet;
}

// ---------------------------------------------------------------------------
// Decoration builders
// ---------------------------------------------------------------------------

const frontmatterLineDeco = Decoration.line({ class: FRONTMATTER_LINE_CLASS });

function buildDecorations(state: EditorState, hidden: boolean): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(state);

  tree.iterate({
    enter(node) {
      if (node.name !== FRONTMATTER_NODE_NAME) return;

      if (hidden) {
        // block: true is permitted in StateField decorations (not in ViewPlugin)
        builder.add(
          node.from,
          node.to,
          Decoration.replace({
            widget: new FrontmatterEmptyWidget(),
            block: true,
          }),
        );
      } else {
        // Raw view: line decoration per frontmatter line (Phase 5 behavior)
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

// ---------------------------------------------------------------------------
// StateField — holds hidden state + decorations (required for block decos)
// ---------------------------------------------------------------------------

/**
 * frontmatterDecoField — StateField holding `{ hidden, decos }`.
 *
 * Block decorations MUST be provided by a StateField in CM6.
 * The field starts with `hidden: true` (D-13 default).
 * On `toggleFrontmatterVisibility` effect, flips `hidden` and rebuilds.
 *
 * `EditorView.decorations.from(field, ...)` plugs the decos into rendering.
 */
const frontmatterDecoField = StateField.define<FrontmatterFieldState>({
  create(state) {
    const decos = buildDecorations(state, true /* hidden by default */);
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
    // Map decos through changes (covers position shifts from unrelated edits)
    return { hidden: prev.hidden, decos: prev.decos.map(tr.changes) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

// ---------------------------------------------------------------------------
// ViewPlugin — shim for test introspection + D-13 mount reset
// ---------------------------------------------------------------------------

/**
 * frontmatterHidePlugin — thin ViewPlugin shim.
 *
 * Primary purpose 1 (D-13 reset): On every new EditorView mount (note switch),
 * dispatch the reset effect so the StateField starts with `hidden=true`.
 * Uses a `requestAnimationFrame`-deferred dispatch to avoid dispatching
 * during construction (CM6 prohibits dispatching in EditorView constructors).
 *
 * Primary purpose 2 (test introspection): exposes `decorations` property so
 * tests can inspect the current decoration set via `view.plugin(frontmatterHidePlugin)`.
 *
 * The block decorations are provided by `frontmatterDecoField` (StateField),
 * not by this ViewPlugin (CM6 constraint).
 */
export const frontmatterHidePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      // Read current decorations from the StateField.
      // StateField.create() initializes to hidden=true (D-13 default).
      // Each new EditorView gets a fresh EditorState, so hidden=true on every mount.
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

// ---------------------------------------------------------------------------
// Combined extension export
// ---------------------------------------------------------------------------

/**
 * frontmatterHideExtension — the full extension set to add to MarkdownEditor.
 * Includes the StateField (block decorations) and the ViewPlugin (D-13 reset).
 *
 * Usage in MarkdownEditor.tsx:
 *   import { frontmatterHideExtension, frontmatterToggleKeymap } from "../editor/frontmatterHidePlugin";
 *   // In extensions: frontmatterHideExtension, frontmatterToggleKeymap,
 */
export const frontmatterHideExtension: Extension = [frontmatterDecoField, frontmatterHidePlugin];

// ---------------------------------------------------------------------------
// Keymap — Cmd-Shift-Y toggle
// ---------------------------------------------------------------------------

/**
 * frontmatterToggleKeymap — CM6 keymap binding for Cmd-Shift-Y (Mod-Shift-y).
 * Place BEFORE `defaultKeymap` in MarkdownEditor.tsx for priority.
 */
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
