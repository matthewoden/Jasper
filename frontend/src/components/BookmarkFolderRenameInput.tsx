/**
 * Inline rename for a bookmark-folder row. Shares NewBookmarkFolderInput's
 * shell (Enter/Tab/Esc/blur-commit, trim + non-empty validation only — these
 * are virtual labels, not filesystem names) but seeds and selects the current
 * name; that component takes no initial value.
 */
import {
  type ChangeEvent,
  type KeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export interface BookmarkFolderRenameInputProps {
  initialValue: string;
  onCommit: (name: string) => Promise<void> | void;
  onCancel: () => void;
}

const inputBaseStyle: React.CSSProperties = {
  height: 24,
  padding: "0 4px",
  background: "var(--color-bg)",
  border: "1px solid var(--color-border)",
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--color-fg)",
  outline: "none",
  fontFamily: "inherit",
  width: "100%",
};

const errorMessageStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 400,
  color: "var(--color-destructive)",
  marginTop: 2,
};

export function BookmarkFolderRenameInput({
  initialValue,
  onCommit,
  onCancel,
}: BookmarkFolderRenameInputProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
    setError(undefined);
  }, []);

  const commit = useCallback(async () => {
    if (settled.current) return;
    const trimmed = value.trim();
    if (trimmed === "") {
      setError("Folder name can't be empty.");
      return;
    }
    settled.current = true;
    if (trimmed === initialValue) {
      onCancel();
      return;
    }
    try {
      await onCommit(trimmed);
    } catch (e) {
      // A refused rename (a duplicate folder name) must leave the field
      // mounted and still holding what the user typed.
      settled.current = false;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [value, initialValue, onCommit, onCancel]);

  const cancel = useCallback(() => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  }, [onCancel]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        void commit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
    [commit, cancel],
  );

  const stopEvent = useCallback((e: SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const c = containerRef.current;
      if (!c || c.contains(e.target as Node)) return;
      void commit();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [commit]);

  return (
    <div
      ref={containerRef}
      style={{ padding: "4px 8px", display: "flex", flexDirection: "column" }}
      data-testid="bookmark-folder-rename-input"
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={stopEvent}
        onMouseDown={stopEvent}
        onClick={stopEvent}
        style={{
          ...inputBaseStyle,
          borderColor: error ? "var(--color-destructive)" : "var(--color-border)",
        }}
        aria-invalid={error ? "true" : undefined}
        aria-label="Bookmark folder name"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />
      {error && (
        <div role="alert" style={errorMessageStyle}>
          {error}
        </div>
      )}
    </div>
  );
}
