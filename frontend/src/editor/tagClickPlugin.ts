/**
 * tagClickPlugin — CM6 ViewPlugin that decorates tag string values inside
 * the YAML `tags: [...]` frontmatter array as clickable spans.
 *
 * Phase 6 / Plan 06-10 / Task 1.
 *
 * D-08: Tag strings inside `tags: [...]` are clickable. Clicking filters
 * the sidebar by that tag. Plain click (NO Cmd/Ctrl required) — this is
 * an intentional divergence from wiki-links' Cmd-click model (D-15).
 * Rationale: tag values in frontmatter are not regular editing targets
 * the way wikilink text is; clicking them is an explicit browse gesture.
 *
 * Node names from SPIKE-FINDINGS.md (Plan 06-01, empirically verified):
 *   Full chain: Frontmatter > Stream > Document > BlockMapping > Pair
 *               > FlowSequence > Item > Literal
 *   - `Literal`      — exact tag-value leaf (e.g. "alpha", "beta-tag")
 *   - `FlowSequence` — the [...] array wrapper
 *   - `Pair`         — key-value mapping entry
 *
 * `isInsideTagsPair` walks ancestors from the `Literal` node upward:
 *   1. Find a `FlowSequence` ancestor (confirms we are in an array)
 *   2. Find a `Pair` ancestor above the FlowSequence
 *   3. The Pair's first child (key) text must equal "tags"
 *
 * IME gate: u.view.composing → map existing decorations through u.changes
 * instead of rebuilding. Matches frontmatterPlugin and livePreviewPlugin patterns.
 *
 * CSS class: `cm-tag-clickable` — styled in themeBridge.ts (Plan 06-10).
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
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { FRONTMATTER_NODE_NAME } from "./frontmatterPlugin";

// ---------------------------------------------------------------------------
// Module-level tag-click callback — populated by MarkdownEditor.tsx.
// Mirrors the wikilinkResolver module-level snapshot pattern.
// ---------------------------------------------------------------------------

let _onTagClick: ((tag: string) => void) | null = null;

/**
 * Register the callback invoked when a cm-tag-clickable span is clicked.
 * Called from MarkdownEditor's useEffect with a fresh closure over
 * useTreeStore's setActiveTagFilter + setTagBrowserExpanded.
 */
export function setTagClickHandler(fn: (tag: string) => void): void {
  _onTagClick = fn;
}

// ---------------------------------------------------------------------------
// Decoration instance (shared; Decoration.mark is immutable and cacheable)
// ---------------------------------------------------------------------------

const TAG_DECO = Decoration.mark({ class: "cm-tag-clickable" });

// ---------------------------------------------------------------------------
// isInsideTagsPair — checks that a Literal node is inside the tags: [...] array.
//
// From SPIKE-FINDINGS.md (Plan 06-01):
//   Walk ancestors of the Literal node upward:
//     1. FlowSequence — confirms we're inside [...]
//     2. Pair above FlowSequence — the key-value entry
//     3. Pair's first child (key) text === "tags"
//
// Returns false if:
//   - No FlowSequence ancestor found (e.g. block-sequence, scalar value)
//   - Pair key is not "tags" (different YAML key)
// ---------------------------------------------------------------------------

function isInsideTagsPair(node: SyntaxNode, state: EditorState): boolean {
  let cur: SyntaxNode | null = node.parent;
  let foundFlowSequence = false;

  while (cur) {
    if (cur.name === "FlowSequence") {
      foundFlowSequence = true;
    }
    if (cur.name === "Pair" && foundFlowSequence) {
      // The Pair's first child is the key node.
      const key = cur.firstChild;
      if (key && state.doc.sliceString(key.from, key.to) === "tags") {
        return true;
      }
      // Found a Pair but key is not "tags" — not our target.
      return false;
    }
    // Stop walking up once we leave the Frontmatter node.
    if (cur.name === FRONTMATTER_NODE_NAME) break;
    cur = cur.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// buildTagDecorations — iterates the Frontmatter subtree, emitting
// Decoration.mark for every Literal node that passes isInsideTagsPair.
// ---------------------------------------------------------------------------

function buildTagDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);

  tree.iterate({
    enter(node) {
      // Only descend into Frontmatter; skip all other top-level nodes.
      if (node.name !== FRONTMATTER_NODE_NAME) return;

      // Walk the entire Frontmatter subtree looking for Literal nodes.
      const cursor = node.node.cursor();
      do {
        if (cursor.name === "Literal") {
          if (isInsideTagsPair(cursor.node, view.state)) {
            builder.add(cursor.from, cursor.to, TAG_DECO);
          }
        }
      } while (cursor.next());
    },
  });

  return builder.finish();
}

// ---------------------------------------------------------------------------
// ViewPlugin + event handler
// ---------------------------------------------------------------------------

/**
 * tagClickPlugin — the CM6 extension to add to MarkdownEditor's extensions array.
 *
 * Provides:
 *   1. Decoration.mark("cm-tag-clickable") on Literal tag values in frontmatter.
 *   2. eventHandlers.click — plain click (no Cmd/Ctrl) on the decorated span
 *      calls _onTagClick(tagName) (D-08 plain-click model).
 */
export const tagClickPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildTagDecorations(view);
    }

    update(u: ViewUpdate) {
      if (u.view.composing) {
        // IME gate (D-07/D-31 pattern): map existing decorations through
        // document changes instead of rebuilding during IME composition.
        this.decorations = this.decorations.map(u.changes);
        return;
      }
      if (
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = buildTagDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      click(event: MouseEvent, view: EditorView) {
        void view; // view available if needed for future enhancements
        const target = event.target as HTMLElement | null;
        if (!target?.classList.contains("cm-tag-clickable")) return false;

        const tag = target.textContent?.trim();
        if (!tag) return false;

        // D-08: plain click model — no modifier key required.
        // This deliberately diverges from wiki-links' Cmd-click model (D-15).
        _onTagClick?.(tag);
        event.preventDefault();
        return true;
      },
    },
  },
);
