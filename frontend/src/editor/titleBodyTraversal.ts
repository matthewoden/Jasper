/**
 * titleBodyTraversal — the CM6 keymap + helper bridging the plain-DOM
 * TitleElement and the CM6 body (D-18 through D-21).
 *
 * "First visible body line" must skip BOTH independently-hidden regions:
 * the frontmatter block AND the first ATX H1 line (both hidden AND
 * atomic-range-guarded, in frontmatterHidePlugin.ts and firstH1HidePlugin.ts
 * respectively — TitleElement renders the H1 above the editor instead).
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
 * Pure geometry check (CR-01, extracted for unit-testability): is the caret's
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
 * Returns the boundary of the FIRST ATX H1's HIDDEN region, or null when the
 * doc has none. Mirrors firstH1HidePlugin.ts's own hide-scan (first-match-
 * wins, `done` gate) for locating the node, but the returned boundary is
 * NOT simply the node's `.to` — firstH1HidePlugin.ts's hide decoration
 * extends through the H1's own trailing newline (required for CM6 to
 * collapse the row's height correctly; a bare node-range replace leaves a
 * normal-height phantom row behind, the Phase 31 UAT round-2 root cause).
 * As an emergent CM6 rendering behavior, that one-character extension ALSO
 * merges an immediately-following BLANK line (if any) into the same hidden
 * block — a zero-length line starting exactly at that boundary never gets
 * its own rendered row. firstVisibleBodyLine()'s own boundary-resolution
 * step (below) is what actually accounts for that merged blank line; this
 * function only computes the raw extended boundary.
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
  // bound can land exactly at a line's end (no more characters before its own
  // newline, e.g. a hidden region that consumes a whole line with nothing
  // else following on it) — in that case the first VISIBLE line is the next
  // one, not the (fully-consumed) line bound resolves onto. EXCEPT when that
  // resolved line is the doc's own LAST line: never skip past it, even when
  // blank — firstH1HidePlugin.ts's hide range extends through the H1's own
  // trailing newline, which (as an emergent CM6 rendering merge) also
  // collapses an immediately-following blank line into the same hidden
  // block when one exists, making `bound` land exactly on that next line's
  // (zero-length) start === end. For a fresh/near-empty note whose only
  // remaining content IS that trailing blank line, skipping "past" it would
  // incorrectly report null ("no visible body line") — there is nowhere
  // left to skip TO, and the line is still a legitimate target (Phase 31
  // UAT round 2: this previously broke ArrowUp entirely for a brand-new,
  // not-yet-typed-into note).
  if (line.to <= bound && line.number < state.doc.lines) {
    return state.doc.line(line.number + 1);
  }
  return line;
}

/**
 * makeTitleBodyTraversalKeymap — ArrowUp handoff (D-19/D-20/D-21). No-ops
 * (returns false, falls through to CM6's normal Up) unless the selection is
 * empty AND the caret sits on the FIRST VISUAL ROW of the first visible body
 * line (CR-01: gating on the logical line alone hijacks Up on any wrapped
 * first line before the caret reaches its own top row). Otherwise reads the
 * caret's pixel X (column preservation is coordinate-based, not
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

      // CR-01 visual-row gate: compute where one visual row up would land
      // via CM6's own vertical-motion primitive (moveVertically uses
      // goalColumn internally, so this is genuine "up one wrapped row", not
      // "up one logical line"). Cross to the title ONLY when that motion
      // would either not move at all (already at the absolute doc top) or
      // land at/before the hidden frontmatter/H1 boundary (would park the
      // caret inside the hidden region) — both signal the caret is already
      // on the line's topmost visual row. Otherwise there is a wrapped row
      // above within this same logical line; let CM6 move up normally.
      //
      // moveVertically depends on real text-layout measurement (coordsAtPos
      // internally) and throws in environments without it (jsdom's Range has
      // no getClientRects) — fall through to the always-cross behavior
      // rather than let the exception swallow the whole keydown, same
      // rationale as the coordsAtPos try/catch below.
      try {
        const boundary = Math.max(frontmatterBoundary(view.state) ?? 0, firstH1To(view.state) ?? 0);
        const moved = view.moveVertically(sel, false);
        if (moved.head !== sel.head && moved.head >= boundary) return false;
      } catch {
        // no real layout available — fall through to cross, matching the
        // pre-CR-01-fix behavior for environments that can't measure rows.
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
