/**
 * TitleElement — Obsidian-style editable inline title (D-01/D-02/READ-01).
 *
 * A plain contentEditable <div> (NOT a second CodeMirror instance) that
 * reads/writes the note's H1 through the EXISTING rename binding. This
 * component never calls fetch/the notes API directly and never opens a
 * second doc-mutation channel — callers must route `onTitleChange` through
 * MarkdownEditor's ref (rewriteH1 -> setContent), which fires the existing
 * onH1Change + rename flow unchanged.
 *
 * Placeholder: when `title` is null/empty, the literal text "Untitled" is
 * rendered (muted color) so the empty state is visible without a note
 * before the user has typed anything. Clicking/focusing clears it; blurring
 * on an empty div restores it.
 *
 * Focus (D-18): caret-only — no focus ring, no hover affordance. The title
 * reads as an ordinary line of the note, not a form field.
 *
 * Enter/ArrowDown (D-19/D-20): both hand off focus to the body, column-
 * preserving. Column preservation is pixel-based, not character-index — the
 * title's much larger font would otherwise land at the wrong visual column
 * (31-RESEARCH.md Pitfall 3). Tab is unchanged (out of scope, D-19).
 *
 * ArrowDown crosses to the body ONLY when the caret is on the title's LAST
 * visual row (CR-01) — the title is `white-space: pre-wrap` and any long
 * enough note title wraps across multiple visual rows; hijacking every
 * ArrowDown regardless of row broke ordinary in-title downward navigation.
 * See caretOnLastVisualRow() below (delegates to isLastVisualRow from
 * titleBodyTraversal).
 */
import { useEffect, useRef } from "react";

import { isLastVisualRow } from "../editor/titleBodyTraversal";

const PLACEHOLDER_TEXT = "Untitled";

/** Reads the collapsed caret's pixel X within the title element, or 0 if unavailable. */
function measureCaretX(): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const rects = sel.getRangeAt(0).getClientRects();
  return rects.length > 0 ? rects[0].left : 0;
}

/**
 * Whether the collapsed caret sits on the title's LAST visual row. Falls
 * back to `true` (always treat as last row → cross, matching the prior
 * always-cross behavior) whenever real caret/line-box geometry isn't
 * available — no selection yet, jsdom's Range/getClientRects not
 * implementing real layout (zero-height rects), or any thrown error from
 * those DOM calls. This keeps unit tests without real text layout exercising
 * the handoff path; the real per-row gating is proven by the E2E suite
 * (phase31-title-traversal.spec.ts) against actual browser layout.
 */
function caretOnLastVisualRow(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  try {
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const caretRect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
    if (!caretRect || caretRect.height === 0) return true;
    const elRect = el.getBoundingClientRect();
    const computedLineHeight = parseFloat(getComputedStyle(el).lineHeight);
    const lineHeight = Number.isFinite(computedLineHeight) ? computedLineHeight : caretRect.height;
    return isLastVisualRow(caretRect.bottom, elRect.bottom, lineHeight);
  } catch {
    return true;
  }
}

export interface TitleElementProps {
  /** Current H1 text (already trimmed by the caller), or null/empty for no H1. */
  title: string | null;
  /** Fires on every input with the raw current text — write-through only, no debounce here. */
  onTitleChange: (next: string) => void;
  /** Fires on Enter/ArrowDown with the measured caret pixel-X, to move column-preserving focus into the doc body. */
  onFocusHandoff: (measuredX: number) => void;
}

export const TitleElement = ({ title, onTitleChange, onFocusHandoff }: TitleElementProps) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const trimmed = (title ?? "").trim();
  const isEmpty = trimmed === "";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el) return;
    const next = isEmpty ? PLACEHOLDER_TEXT : trimmed;
    if (el.textContent !== next) {
      el.textContent = next;
    }
  }, [trimmed, isEmpty]);

  return (
    <div
      ref={ref}
      className="editor-title-element"
      contentEditable
      suppressContentEditableWarning
      data-testid="editor-title-element"
      aria-label="Note title"
      onFocus={() => {
        const el = ref.current;
        if (el && isEmpty) {
          el.textContent = "";
        }
      }}
      onBlur={() => {
        const el = ref.current;
        if (el && (el.textContent ?? "").trim() === "") {
          el.textContent = PLACEHOLDER_TEXT;
        }
      }}
      onInput={() => {
        const el = ref.current;
        if (!el) return;
        onTitleChange(el.textContent ?? "");
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          onFocusHandoff(measureCaretX());
          return;
        }
        if (e.key === "ArrowDown") {
          const el = ref.current;
          // Not on the last visual row — a wrapped row exists below the
          // caret; let the browser move the caret down within the title
          // normally instead of crossing to the body (CR-01).
          if (el && !caretOnLastVisualRow(el)) return;
          e.preventDefault();
          onFocusHandoff(measureCaretX());
        }
      }}
      style={{
        fontSize: 33,
        fontWeight: 700,
        lineHeight: 1.15,
        letterSpacing: "-0.012em",
        fontFamily: "var(--font-reading)",
        color: isEmpty ? "var(--color-muted)" : "var(--color-fg-title)",
        outline: "none",
        border: "none",
        cursor: "text",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    />
  );
};
