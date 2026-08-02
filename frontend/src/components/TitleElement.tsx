/**
 * The editable inline title: a plain contentEditable div, NOT a second CodeMirror.
 * It never calls the notes API — callers must route onTitleChange through
 * MarkdownEditor's ref so the existing rename flow runs unchanged.
 *
 * Enter and ArrowDown hand off to the body preserving column by PIXEL rather than
 * character index; the title's larger font would otherwise land at the wrong
 * visual column. ArrowDown crosses only from the title's LAST visual row — the
 * title is pre-wrap, and hijacking every ArrowDown broke in-title navigation.
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
 * Falls back to `true` (always cross) whenever real caret geometry is
 * unavailable — no selection, or jsdom's zero-height rects. That keeps unit
 * tests exercising the handoff; real per-row gating is proven in E2E.
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
          // normally instead of crossing to the body.
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
