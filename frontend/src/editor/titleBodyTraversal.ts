/**
 * titleBodyTraversal — the CM6 keymap + helper bridging the plain-DOM
 * TitleElement and the CM6 body.
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
 * Returns the boundary of the FIRST ATX H1's HIDDEN region, or null when the
 * doc has none. Mirrors firstH1HidePlugin.ts's own hide-scan (first-match-
 * wins, `done` gate) for locating the node, but the returned boundary is
 * NOT simply the node's `.to` — firstH1HidePlugin.ts's hide decoration
 * extends through the H1's own trailing newline (required for CM6 to
 * collapse the row's height correctly; a bare node-range replace leaves a
 * normal-height phantom row behind).
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
  // left to skip TO, and the line is still a legitimate target (this
  // previously broke ArrowUp entirely for a brand-new, not-yet-typed-into
  // note).
  if (line.to <= bound && line.number < state.doc.lines) {
    return state.doc.line(line.number + 1);
  }
  return line;
}

/**
 * makeTitleBodyTraversalKeymap — ArrowUp handoff. No-ops
 * (returns false, falls through to CM6's normal Up) unless the selection is
 * empty AND the caret sits AT OR BEFORE the first visible body line —
 * gating on the logical line alone hijacks Up on any wrapped first line
 * before the caret reaches its own top row). Otherwise reads the caret's
 * pixel X (column preservation is coordinate-based, not character-index —
 * the title renders at a different font size)
 * and hands off to the title via the callback.
 *
 * "At or before" (not "on"): clicking the mouse in the
 * visual empty gap ABOVE the first visible line — real, un-decorated
 * `.cm-content` padding, or one of the emergent zero-length "merge" lines
 * frontmatterBoundary()/firstH1To() already document (a blank line sitting
 * exactly on the boundary between two block-replace decorations, which CM6
 * folds into neither decoration's own rendered block and never gives its own
 * `.cm-line` row) — can resolve CM6's OWN model caret to a position on one of
 * those earlier, effectively invisible lines instead of onto
 * firstVisibleBodyLine() itself. The DOM/Selection API still reports the
 * caret as visually inside the first rendered row (confirmed via real-browser
 * repro), but `view.state.selection` disagrees, so the strict
 * `curLine.number !== target.number` equality silently no-opped ArrowUp for
 * this click-then-Up gesture specifically (never reached by any
 * keyboard-only path, which is why the round-2 fix's keyboard-driven E2E
 * coverage didn't catch it). Any caret line ABOVE the target is, by
 * construction, inside the collapsed preamble (frontmatter and/or the hidden
 * H1, plus their merge-artifact blank lines) — there is no real content
 * there for the user to be "in", so crossing to the title is always correct
 * regardless of visual row. A caret line BELOW the target is genuinely
 * further into the body and must never cross.
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

      // Visual-row gate: compute where one visual row up would land
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
