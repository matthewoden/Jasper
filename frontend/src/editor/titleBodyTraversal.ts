/**
 * titleBodyTraversal bridges the plain-DOM TitleElement and the CM6 body.
 *
 * "First visible body line" must skip BOTH hidden regions — frontmatter and the
 * first ATX H1. Computing it from frontmatter alone lands Down/Enter-from-title
 * on the invisible H1 instead.
 */
import { EditorView, keymap } from "@codemirror/view";
import type { KeyBinding } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Line } from "@codemirror/state";
import { FRONTMATTER_NODE_NAME } from "./frontmatterPlugin";

/**
 * Pure geometry check (extracted for unit-testability): is the caret's
 * bottom edge within one line-height of the element's own bottom edge? That is
 * "last visual row" — the title wraps a long name across multiple visual rows
 * (pre-wrap), and ArrowDown should only cross to the body once there is no
 * wrapped row below the caret's own row. Lives here (not in TitleElement) so
 * the component file only exports components (react-refresh).
 */
export function isLastVisualRow(
  caretBottom: number,
  elementBottom: number,
  lineHeight: number,
): boolean {
  return elementBottom - caretBottom < lineHeight;
}

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
 * Boundary of the first ATX H1's HIDDEN region, or null.
 *
 * NOT the node's `.to`: the hide decoration extends through the trailing
 * newline, and CM6 then merges an immediately-following blank line into the
 * same hidden block, giving it no rendered row. firstVisibleBodyLine() handles
 * that merged line; this returns only the raw extended boundary.
 */
function firstH1To(state: EditorState): number | null {
  let to: number | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (to !== null || node.name !== "ATXHeading1") return;
      to = node.to;
    },
  });
  if (to === null) return null;
  // +1: extend through the H1's own trailing newline, matching
  // firstH1HidePlugin.ts's hide-decoration range exactly (required there
  // for CM6 to collapse the row's height correctly). This makes firstH1To's
  // return value the START of the next line, the same convention
  // frontmatterBoundary() already uses — see firstVisibleBodyLine()'s own
  // handling of a resulting boundary that lands on a zero-length line.
  return Math.min(to + 1, state.doc.length);
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
  // A fully-consumed line means the first VISIBLE line is the next one —
  // EXCEPT on the doc's last line, where there is nowhere to skip to. On a
  // brand-new note whose only remaining content is that trailing blank line,
  // skipping would report "no visible body line" and break ArrowUp entirely.
  if (line.to <= bound && line.number < state.doc.lines) {
    return state.doc.line(line.number + 1);
  }
  return line;
}

/**
 * makeTitleBodyTraversalKeymap — the ArrowUp handoff to the title.
 *
 * Column preservation is coordinate-based, not character-index: the title
 * renders at a different font size, so a character offset lands wrong.
 *
 * The gate is "AT OR BEFORE" the first visible body line, not "on" it. Clicking
 * the visual gap above that line can resolve CM6's model caret onto an earlier
 * invisible line while the DOM reports it inside the first rendered row — a
 * strict equality silently no-ops ArrowUp for click-then-Up, which no
 * keyboard-only test reaches. Any line above the target is inside the collapsed
 * preamble with no real content to be "in", so crossing is always right there.
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
      if (curLine.number > target.number) return false;

      // Caret is strictly ABOVE the first visible line (the click-in-the-gap
      // case above) — no wrapped-row concept applies there (it isn't real,
      // rendered body content), so cross unconditionally rather than running
      // the moveVertically gate below (which assumes curLine IS the
      // target line).
      if (curLine.number < target.number) {
        let x = 0;
        try {
          const coords = view.coordsAtPos(sel.head);
          if (coords) x = coords.left;
        } catch {
          x = 0;
        }
        onCrossToTitle(x);
        return true;
      }

      // Visual-row gate, via CM6's own moveVertically so this is genuinely
      // "up one wrapped row" rather than "up one logical line". Cross only when
      // that motion would not move or would land inside the hidden region —
      // both mean the caret is already on its topmost visual row.
      //
      // moveVertically needs real text-layout measurement and throws in jsdom;
      // fall through to always-cross rather than let it swallow the keydown.
      try {
        const boundary = Math.max(frontmatterBoundary(view.state) ?? 0, firstH1To(view.state) ?? 0);
        const moved = view.moveVertically(sel, false);
        if (moved.head !== sel.head && moved.head >= boundary) return false;
      } catch {
        // no real layout available — fall through to cross, matching the
        // pre-fix behavior for environments that can't measure rows.
      }

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
