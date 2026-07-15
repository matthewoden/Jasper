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
 */
import { useEffect, useRef } from "react";

const PLACEHOLDER_TEXT = "Untitled";

export interface TitleElementProps {
  /** Current H1 text (already trimmed by the caller), or null/empty for no H1. */
  title: string | null;
  /** Fires on every input with the raw current text — write-through only, no debounce here. */
  onTitleChange: (next: string) => void;
  /** Fires on Enter/Tab to move focus into the doc body. */
  onFocusHandoff: () => void;
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
    <>
      <style>{`
        .editor-title-element:focus {
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 25%, transparent);
          border-radius: 2px;
        }
      `}</style>
      <div
        ref={ref}
        className="editor-title-element"
        contentEditable
        suppressContentEditableWarning
        data-testid="editor-title-element"
        aria-label="Note title"
        role="textbox"
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
            onFocusHandoff();
          }
        }}
        style={{
          fontSize: 33,
          fontWeight: 700,
          lineHeight: 1.2,
          fontFamily: "var(--font-reading)",
          color: isEmpty ? "var(--color-muted)" : "var(--color-fg-title)",
          outline: "none",
          border: "none",
          cursor: "text",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      />
    </>
  );
};
