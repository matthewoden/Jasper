/**
 * RenameInput — UI-SPEC §Surface 3 inline rename.
 *
 * Pure input + validation + Enter/Esc/Tab/click-outside handling. The
 * caller (TreeRow) mounts this in place of the row label when
 * useTreeStore.pendingRename matches the current row.
 *
 * Validation rules (locked):
 *   - empty → "Name cannot be empty."
 *   - illegal char (/, \, :, *, ?, ", <, >, |, control chars) →
 *     "Use letters, numbers, dashes, and underscores only."
 *   - case-insensitive collision against siblingNames →
 *     "Already exists."
 *
 * Enter / Tab / click-outside: commit (call onCommit). Esc: cancel
 * (call onCancel). If onCommit throws TreeMutationError, the input
 * stays mounted and the inline error switches to the server's
 * message — the user can edit + retry.
 *
 * The .md extension is stripped by the caller; we only render the
 * basename. Folder names render in full.
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

import { TreeMutationError } from "../lib/useTreeMutations";

// eslint-disable-next-line no-control-regex -- intentionally rejects ASCII control chars in user-typed names
const ILLEGAL_CHAR_REGEX = /[/\\:*?"<>|\x00-\x1F]/;

export interface ValidateResult {
  valid: boolean;
  error?: string;
}

export function validateRename(
  value: string,
  siblingNames: string[],
): ValidateResult {
  if (value === "")
    return { valid: false, error: "Name cannot be empty." };
  if (ILLEGAL_CHAR_REGEX.test(value))
    return {
      valid: false,
      error: "Use letters, numbers, dashes, and underscores only.",
    };
  const lower = value.toLowerCase();
  for (const sib of siblingNames) {
    if (sib.toLowerCase() === lower)
      return { valid: false, error: "Already exists." };
  }
  return { valid: true };
}

export interface RenameInputProps {
  initialValue: string;
  isFolder: boolean;
  siblingNames: string[];
  onCommit: (newValue: string) => Promise<void>;
  onCancel: () => void;
}

const inputBaseStyle: React.CSSProperties = {
  height: 24,
  padding: "0 4px",
  background: "var(--color-bg)",
  border: "1px solid var(--color-border)",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 400,
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
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

export function RenameInput({
  initialValue,
  // isFolder is reserved for future variant-specific behavior; the
  // caller already strips .md before passing initialValue, so we don't
  // branch on it inside this component today.
  isFolder: _isFolder,
  siblingNames,
  onCommit,
  onCancel,
}: RenameInputProps) {
  void _isFolder;
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Avoid double-firing commit when both keydown(Enter|Tab) and
  // click-outside are observed in close succession.
  const committedOrCancelled = useRef(false);

  // Mount: focus + select-all so user can immediately overtype OR press End.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Re-validate whenever value or siblingNames change.
  useEffect(() => {
    const r = validateRename(value, siblingNames);
    setError(r.valid ? undefined : r.error);
  }, [value, siblingNames]);

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
  }, []);

  const commit = useCallback(async () => {
    if (committedOrCancelled.current) return;
    const r = validateRename(value, siblingNames);
    if (!r.valid) {
      setError(r.error);
      return;
    }
    committedOrCancelled.current = true;
    try {
      await onCommit(value);
    } catch (e) {
      committedOrCancelled.current = false;
      if (e instanceof TreeMutationError) {
        setError(e.message);
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError("Server error.");
      }
    }
  }, [value, siblingNames, onCommit]);

  const cancel = useCallback(() => {
    if (committedOrCancelled.current) return;
    committedOrCancelled.current = true;
    onCancel();
  }, [onCancel]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // Stop EVERY key from bubbling to the tree's keymap. react-arborist
      // listens at the tree-container level for first-letter-jump
      // (alphanumerics), Enter (open / toggle), Escape (close), and arrow
      // keys (navigation). While the rename input is mounted, NONE of
      // those should fire — the input is the active control. (Gap 4)
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
      // For all other keys (alphanumeric, etc.) we let the input's
      // default behavior insert the character — propagation is already
      // stopped above, so the tree's keymap never sees it.
    },
    [commit, cancel],
  );

  // Some browsers' keyboard pipelines listen on keyup / keypress phases
  // as well; trap those too so nothing escapes to the tree's keymap.
  // (Gap 4)
  const handleKeyUpOrPress = useCallback((e: SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  // Click outside → commit (VS Code convention). Listens on document
  // mousedown so it fires before focus shifts.
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
      style={{ flex: 1, display: "flex", flexDirection: "column" }}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUpOrPress}
        onKeyPress={handleKeyUpOrPress}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        style={inputStyle}
        aria-invalid={error ? "true" : undefined}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        title={error}
      />
      {error && (
        <div role="alert" style={errorMessageStyle}>
          {error}
        </div>
      )}
    </div>
  );
}
