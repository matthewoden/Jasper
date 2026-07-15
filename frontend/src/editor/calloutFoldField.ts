/**
 * calloutFoldField — CM6 extension tracking which foldable callouts
 * (`> [!type]-` — trailing dash) are collapsed, and hiding their body
 * lines when folded (READ-02, D-07).
 *
 * Block decorations must come from a StateField, not a ViewPlugin (CM6
 * constraint: "Block decorations may not be specified via plugins").
 *
 * Folded state is keyed by the blockquote's start position (`Set<number>`,
 * not a single boolean — mirrors frontmatterHidePlugin.ts's toggle-effect +
 * StateField shape, but supports multiple independent callouts). Foldable
 * callouts start COLLAPSED the first time they're seen (seeded from
 * `[!type]-` callouts at `create` AND on every subsequent docChanged for
 * any position not already tracked in `known`) — this covers both a
 * same-session `create()` with real content already present, and the
 * common app pattern of mounting with `initialDoc=""` and loading the
 * real content later via a docChanged `applyServerUpdate` transaction
 * (MarkdownEditor.tsx). Session-level only — never persisted across reloads.
 *
 * The fold chevron itself is rendered by livePreviewPlugin.ts's
 * CalloutTitleWidget (same title-line widget as the dot/title), which
 * reads `isCalloutFolded()` to pick ChevronRight (collapsed) vs
 * ChevronDown (expanded) and dispatches `toggleCalloutFold` on click.
 */
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Transaction, Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/** Regex for a callout's first line (after stripping "> "), requiring the fold dash. */
const FOLDABLE_CALLOUT_RE = /^\[!(\w+)\](-)\s*(.*)$/;

/** Toggles fold state for the callout (Blockquote) starting at `from`. */
export const toggleCalloutFold = StateEffect.define<{ from: number }>();

interface CalloutFoldFieldState {
  folded: Set<number>;
  /** Every foldable-callout position we've already made a fold-state decision for. */
  known: Set<number>;
  decos: DecorationSet;
}

/** Finds every foldable ("[!type]-") callout's Blockquote start position. */
function findFoldableCalloutStarts(state: EditorState): Set<number> {
  const result = new Set<number>();
  const tree = syntaxTree(state);
  tree.iterate({
    enter(node) {
      if (node.name !== "Blockquote") return;
      const line = state.doc.lineAt(node.from);
      const stripped = line.text.replace(/^>\s?/, "");
      if (FOLDABLE_CALLOUT_RE.test(stripped)) {
        result.add(node.from);
      }
    },
  });
  return result;
}

function buildFoldDecorations(state: EditorState, folded: Set<number>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (folded.size === 0) return builder.finish();

  const tree = syntaxTree(state);
  const entries: { from: number; to: number }[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== "Blockquote") return;
      if (!folded.has(node.from)) return;
      const firstLine = state.doc.lineAt(node.from);
      const bodyFrom = firstLine.to + 1; // start of the second line, if any
      if (bodyFrom >= node.to) return; // no body lines to hide
      entries.push({ from: bodyFrom, to: node.to });
    },
  });

  entries.sort((a, b) => a.from - b.from);
  for (const { from, to } of entries) {
    if (from >= to) continue;
    builder.add(from, to, Decoration.replace({ block: true }));
  }
  return builder.finish();
}

const calloutFoldDecoField = StateField.define<CalloutFoldFieldState>({
  create(state) {
    const folded = findFoldableCalloutStarts(state);
    return { folded, known: new Set(folded), decos: buildFoldDecorations(state, folded) };
  },
  update(prev, tr: Transaction) {
    let folded = prev.folded;
    let known = prev.known;
    let changed = false;

    for (const effect of tr.effects) {
      if (!effect.is(toggleCalloutFold)) continue;
      if (!changed) {
        folded = new Set(prev.folded);
        known = new Set(prev.known);
        changed = true;
      }
      const pos = effect.value.from;
      if (folded.has(pos)) {
        folded.delete(pos);
      } else {
        folded.add(pos);
      }
      known.add(pos);
    }

    if (tr.docChanged) {
      if (!changed) {
        folded = new Set(prev.folded);
        known = new Set(prev.known);
        changed = true;
      }
      const remappedFolded = new Set<number>();
      for (const pos of folded) remappedFolded.add(tr.changes.mapPos(pos));
      const remappedKnown = new Set<number>();
      for (const pos of known) remappedKnown.add(tr.changes.mapPos(pos));

      // Seed newly-appeared foldable callouts (not previously tracked) as
      // collapsed — covers both a real initial load and a docChanged
      // server-update replace of a previously-empty document.
      for (const pos of findFoldableCalloutStarts(tr.state)) {
        if (!remappedKnown.has(pos)) {
          remappedFolded.add(pos);
          remappedKnown.add(pos);
        }
      }

      folded = remappedFolded;
      known = remappedKnown;
    }

    if (!changed) return prev;
    return { folded, known, decos: buildFoldDecorations(tr.state, folded) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

/** Reads whether the callout (Blockquote) starting at `from` is currently folded. */
export function isCalloutFolded(state: EditorState, from: number): boolean {
  const field = state.field(calloutFoldDecoField, false);
  return field ? field.folded.has(from) : false;
}

/**
 * calloutFoldExtension — hides a folded callout's body lines. Must be
 * combined with livePreviewPlugin (which renders the fold chevron and
 * dispatches toggleCalloutFold on click).
 */
export const calloutFoldExtension: Extension = [calloutFoldDecoField];

/** Exported for livePreviewPlugin.ts's buildDecorations() to read fold state directly. */
export { calloutFoldDecoField };
