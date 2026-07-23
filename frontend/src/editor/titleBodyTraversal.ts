/**
 * titleBodyTraversal — the CM6 keymap + helper bridging the plain-DOM
 * TitleElement and the CM6 body (D-18 through D-21).
 *
 * "First visible body line" must skip BOTH independently-hidden regions:
 * the frontmatter block (frontmatterHidePlugin.ts, has its own atomicRanges
 * guard) AND the first ATX H1 line (firstH1HidePlugin.ts, hidden but NOT
 * atomic-range-guarded — TitleElement renders that H1 above the editor).
 * Computing the boundary from frontmatter alone would land Down/Enter-from-
 * title directly on the invisible H1 line instead of the true first visible
 * body line.
 */
import { EditorView, keymap } from "@codemirror/view";
import type { KeyBinding } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Line } from "@codemirror/state";
import { FRONTMATTER_NODE_NAME } from "./frontmatterPlugin";

/**
 * Returns the frontmatter node's `.to` boundary, or null when the doc has
 * none. Mirrors frontmatterHidePlugin.ts's own (unexported) helper of the
 * same name/shape — duplicated rather than imported since that module does
 * not export it.
 */
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
 * Returns the FIRST ATX H1 node's `.to`, or null when the doc has none.
 * Mirrors firstH1HidePlugin.ts's own hide-scan (first-match-wins, `done` gate).
 */
function firstH1To(state: EditorState): number | null {
  let to: number | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (to !== null || node.name !== "ATXHeading1") return;
      to = node.to;
    },
  });
  return to;
}

/**
 * firstVisibleBodyLine — the Line the caret should land on when entering the
 * body from the title: the first line after BOTH hidden regions. Returns
 * null when the document has no content below them (caller lands at doc end).
 */
export function firstVisibleBodyLine(state: EditorState): Line | null {
  const bound = Math.max(frontmatterBoundary(state) ?? 0, firstH1To(state) ?? 0);
  if (bound >= state.doc.length) return null;
  const line = state.doc.lineAt(bound);
  // bound can land exactly at a line's end (no more characters before its own
  // newline, e.g. a hidden region that consumes a whole line with nothing
  // else following on it) — in that case the first VISIBLE line is the next
  // one, not the (fully-consumed) line bound resolves onto.
  if (line.to <= bound) {
    return line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  }
  return line;
}

/**
 * makeTitleBodyTraversalKeymap — ArrowUp handoff (D-19/D-20/D-21). No-ops
 * (returns false, falls through to CM6's normal Up) unless the selection is
 * empty and the caret sits on the first visible body line; otherwise reads
 * the caret's pixel X (column preservation is coordinate-based, not
 * character-index — the title renders at a different font size, see
 * 31-RESEARCH.md Pitfall 3) and hands off to the title via the callback.
 */
export function makeTitleBodyTraversalKeymap(
  onCrossToTitle: (measuredX: number) => void,
): Extension {
  const binding: KeyBinding = {
    key: "ArrowUp",
    run(view: EditorView): boolean {
      const sel = view.state.selection.main;
      if (!sel.empty) return false;
      const target = firstVisibleBodyLine(view.state);
      if (!target) return false;
      const curLine = view.state.doc.lineAt(sel.head);
      if (curLine.number !== target.number) return false;
      // coordsAtPos can throw in environments without real text-layout
      // support (jsdom's unit-test DOM) — fall back to 0 rather than let the
      // exception swallow the whole keydown (CM6 drops handled=false on throw).
      let x = 0;
      try {
        const coords = view.coordsAtPos(sel.head);
        if (coords) x = coords.left;
      } catch {
        x = 0;
      }
      onCrossToTitle(x);
      return true;
    },
  };
  return keymap.of([binding]);
}
