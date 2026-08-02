/**
 * NewBookmarkFolderInput — inline "New bookmark folder" text input.
 *
 * Reuses RenameInput's Enter/Tab/Esc/blur-commit keyboard shell and
 * inputBaseStyle verbatim (bumped to Heading 13/600, since this
 * replaces a Heading-weight row, not a Body-weight tree row) — but does NOT
 * import validateRename (`renameInput.utils.ts`), which enforces filesystem-
 * legal-character + on-disk sibling-collision rules that don't apply to a
 * virtual bookmark-folder label. Validation here is local: trim + non-empty.
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

export interface NewBookmarkFolderInputProps {
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

/** Local validator: virtual UI labels only need trim + non-empty (no filesystem rules). */
function validateFolderName(value: string): { valid: true } | { valid: false; error: string } {
  if (value.trim() === "") {
    return { valid: false, error: "Folder name can't be empty." };
  }
  return { valid: true };
}

export function NewBookmarkFolderInput({
  onCommit,
  onCancel,
}: NewBookmarkFolderInputProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const committedOrCancelled = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
    setError(undefined);
  }, []);

  const commit = useCallback(async () => {
    if (committedOrCancelled.current) return;
    const r = validateFolderName(value);
    if (!r.valid) {
      setError(r.error);
      return;
    }
    committedOrCancelled.current = true;
    await onCommit(value.trim());
  }, [value, onCommit]);

  const cancel = useCallback(() => {
    if (committedOrCancelled.current) return;
    committedOrCancelled.current = true;
    onCancel();
  }, [onCancel]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        void commit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
        return;
      }
    },
    [commit, cancel],
  );

  const handleKeyUpOrPress = useCallback((e: SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const c = containerRef.current;
      if (!c) return;
      if (c.contains(e.target as Node)) return;
      void commit();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [commit]);

  const inputStyle: React.CSSProperties = {
    ...inputBaseStyle,
    borderColor: error ? "var(--color-destructive)" : "var(--color-border)",
  };

  return (
    <div
      ref={containerRef}
      style={{ padding: "4px 8px", display: "flex", flexDirection: "column" }}
      data-testid="new-bookmark-folder-input"
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder="Folder name"
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUpOrPress}
        onKeyPress={handleKeyUpOrPress}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        style={inputStyle}
        aria-invalid={error ? "true" : undefined}
        aria-label="New bookmark folder name"
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
