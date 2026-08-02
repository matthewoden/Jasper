/**
 * FindReplaceBar — per-pane Find / Find-and-Replace bar (WS-09).
 *
 * Custom React chrome driving
 * @codemirror/search commands underneath, replacing CM6's off-brand built-in
 * panel. Fully controlled — the parent (LeafPane) owns query/toggle state and
 * drives the active pane's EditorView; this component only renders and emits
 * intent callbacks.
 *
 * Chrome idiom mirrors SearchInputBar.tsx: inline `focused` state driving an
 * accent border + 20% box-shadow ring, and a muted→fg hover X close button.
 */
import { useEffect, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from "lucide-react";

export type FindReplaceMode = "find" | "replace";
export type FindToggleKind = "caseSensitive" | "regexp" | "wholeWord";

export interface MatchCount {
  current: number;
  total: number;
}

interface FindReplaceBarProps {
  mode: FindReplaceMode;
  query: string;
  replaceText: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
  matchCount: MatchCount;
  onQueryChange: (next: string) => void;
  onReplaceTextChange: (next: string) => void;
  onToggle: (kind: FindToggleKind) => void;
  onFindNext: () => void;
  onFindPrev: () => void;
  onReplaceNext: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

function formatMatchCount({ total }: MatchCount): string {
  if (total === 0) return "0 matches";
  if (total === 1) return "1 match";
  return `${total} matches`;
}

function inputStyle(focused: boolean): React.CSSProperties {
  return {
    flex: 1,
    background: "var(--color-surface)",
    border: focused ? "1px solid var(--color-accent)" : "1px solid var(--color-border-input)",
    boxShadow: focused
      ? "0 0 0 2px color-mix(in srgb, var(--color-accent) 20%, transparent)"
      : "none",
    borderRadius: 6,
    color: "var(--color-fg)",
    fontSize: 13,
    padding: "5px 9px",
    fontFamily: "inherit",
    outline: "none",
    minWidth: 0,
    transition: "border-color 0.1s, box-shadow 0.1s",
  };
}

const iconToggleBase: React.CSSProperties = {
  width: 24,
  height: 24,
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  borderRadius: 5,
  color: "var(--color-muted)",
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "var(--color-btn-secondary-bg)",
  border: "1px solid var(--color-btn-secondary-border)",
  color: "var(--color-btn-secondary-fg)",
  fontSize: 13,
  fontWeight: 400,
  borderRadius: 6,
  padding: "5px 11px",
  cursor: "pointer",
  flexShrink: 0,
};

const replaceAllButtonStyle: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-accent) 28%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-accent) 50%, transparent)",
  // The translucent accent tint keeps this button's
  // effective background dark, so it needs a bright foreground token, not
  // --color-bg (the dark-on-solid-accent pattern used by
  // .vault-picker-button-primary in theme.css, which doesn't apply here).
  color: "var(--color-fg-title)",
  fontSize: 13,
  fontWeight: 400,
  borderRadius: 6,
  padding: "5px 11px",
  cursor: "pointer",
  flexShrink: 0,
};

interface FindInputProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
  onFindNext: () => void;
  onFindPrev: () => void;
}

function FindInput({ inputRef, value, onChange, onFindNext, onFindPrev }: FindInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      placeholder="Find"
      aria-label="Find"
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(e) => {
        // Escape is handled by the container's bubble-phase onKeyDown (single
        // owner of the close behavior — this handler only owns Enter/Shift+Enter).
        if (e.key === "Enter") {
          e.preventDefault();
          if (e.shiftKey) {
            onFindPrev();
          } else {
            onFindNext();
          }
        }
      }}
      style={inputStyle(focused)}
    />
  );
}

function ReplaceInput({
  value,
  onChange,
  onReplaceNext,
}: {
  value: string;
  onChange: (next: string) => void;
  onReplaceNext: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      type="text"
      value={value}
      placeholder="Replace with"
      aria-label="Replace with"
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(e) => {
        // Escape is handled by the container's bubble-phase onKeyDown.
        if (e.key === "Enter") {
          e.preventDefault();
          onReplaceNext();
        }
      }}
      style={inputStyle(focused)}
    />
  );
}

function ToggleButton({
  active,
  ariaLabel,
  onClick,
  children,
}: {
  active: boolean;
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      data-active={active || undefined}
      onClick={onClick}
      style={{
        ...iconToggleBase,
        color: active ? "var(--color-accent)" : "var(--color-muted)",
        background: active
          ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
          : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.color = "var(--color-fg)";
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.color = "var(--color-muted)";
      }}
    >
      {children}
    </button>
  );
}

export function FindReplaceBar({
  mode,
  query,
  replaceText,
  caseSensitive,
  regexp,
  wholeWord,
  matchCount,
  onQueryChange,
  onReplaceTextChange,
  onToggle,
  onFindNext,
  onFindPrev,
  onReplaceNext,
  onReplaceAll,
  onClose,
}: FindReplaceBarProps) {
  const findInputRef = useRef<HTMLInputElement>(null);

  // Autofocus + select existing text on open. Fires once on mount — the bar
  // remounts (fresh open) whenever LeafPane toggles findBar.open, so this
  // correctly re-runs per open.
  useEffect(() => {
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, []);

  // An empty query has nothing to
  // step through, and stepping it would otherwise round-trip into CM6's
  // findNext/findPrevious with an invalid SearchQuery — LeafPane guards
  // that at the handler level, but the chevrons should also visually read
  // as inactive rather than clickable-looking with no query typed.
  const queryEmpty = query.trim() === "";

  return (
    <div
      data-testid="find-bar"
      role="search"
      aria-label={mode === "replace" ? "Find and replace" : "Find"}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8px 22px",
        borderBottom: "1px solid var(--color-border-inner)",
        background: "var(--color-surface-raised)",
        flex: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <FindInput
          inputRef={findInputRef}
          value={query}
          onChange={onQueryChange}
          onFindNext={onFindNext}
          onFindPrev={onFindPrev}
        />
        <span
          data-testid="find-match-count"
          style={{
            fontSize: 12,
            color: "var(--color-muted)",
            minWidth: 56,
            flexShrink: 0,
          }}
        >
          {formatMatchCount(matchCount)}
        </span>
        {/* Prev/next match navigation — steps the
            active-match cursor exactly like Enter/Shift+Enter already do.
            Does NOT change @codemirror/search's all-matches highlighting. */}
        <button
          type="button"
          aria-label="Previous match"
          onClick={onFindPrev}
          disabled={queryEmpty}
          style={{
            ...iconToggleBase,
            opacity: queryEmpty ? 0.4 : 1,
            cursor: queryEmpty ? "default" : "pointer",
          }}
          onMouseEnter={(e) => {
            if (queryEmpty) return;
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-fg)";
          }}
          onMouseLeave={(e) => {
            if (queryEmpty) return;
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-muted)";
          }}
        >
          <ChevronUp size={15} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Next match"
          onClick={onFindNext}
          disabled={queryEmpty}
          style={{
            ...iconToggleBase,
            opacity: queryEmpty ? 0.4 : 1,
            cursor: queryEmpty ? "default" : "pointer",
          }}
          onMouseEnter={(e) => {
            if (queryEmpty) return;
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-fg)";
          }}
          onMouseLeave={(e) => {
            if (queryEmpty) return;
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-muted)";
          }}
        >
          <ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
        </button>
        <ToggleButton
          active={caseSensitive}
          ariaLabel="Match case"
          onClick={() => onToggle("caseSensitive")}
        >
          <CaseSensitive size={15} strokeWidth={2} aria-hidden="true" />
        </ToggleButton>
        <ToggleButton
          active={regexp}
          ariaLabel="Use regular expression"
          onClick={() => onToggle("regexp")}
        >
          <Regex size={15} strokeWidth={2} aria-hidden="true" />
        </ToggleButton>
        <ToggleButton
          active={wholeWord}
          ariaLabel="Match whole word"
          onClick={() => onToggle("wholeWord")}
        >
          <WholeWord size={15} strokeWidth={2} aria-hidden="true" />
        </ToggleButton>
        <button
          type="button"
          aria-label="Close find bar"
          onClick={onClose}
          style={{
            ...iconToggleBase,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-fg)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-muted)";
          }}
        >
          <X size={13} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
      {mode === "replace" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ReplaceInput
            value={replaceText}
            onChange={onReplaceTextChange}
            onReplaceNext={onReplaceNext}
          />
          <button type="button" onClick={onReplaceNext} style={secondaryButtonStyle}>
            Replace
          </button>
          <button type="button" onClick={onReplaceAll} style={replaceAllButtonStyle}>
            Replace All
          </button>
        </div>
      )}
    </div>
  );
}
