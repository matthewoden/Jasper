/**
 * RenameInput — inline rename input mounted by TreeRow when pendingRename matches.
 *
 * Enter / Tab / click-outside: commit. Esc: cancel. If onCommit throws
 * TreeMutationError, the input stays mounted and shows the server's error message.
 *
 * Same-name commit is a no-op (routes to onCancel) unless isNew=true — when
 * isNew, pressing Enter/Tab/blur without changing the placeholder commits it
 * (keeps the file). Escape always cancels even when isNew.
 *
 * Validation: empty → error; illegal chars → error; case-insensitive sibling
 * collision → error. The .md extension is stripped by the caller.
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


import { validateRename } from "./renameInput.utils";

export interface RenameInputProps {
  initialValue: string;
  isFolder: boolean;
  siblingNames: string[];
  onCommit: (newValue: string) => Promise<void>;
  onCancel: () => void;
  /** True when triggered by a create action (placeholder name not yet confirmed).
   *  When isNew=true, Enter/Tab/blur without change commits instead of cancelling. */
  isNew?: boolean;
  /** Bookmark folders are virtual labels, so the filesystem-character rule
   *  does not apply to them. */
  allowAnyCharacters?: boolean;
  /** Names the field for screen readers and tests; the row it replaces
   *  carries no label of its own. */
  ariaLabel?: string;
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
  isFolder: _isFolder,
  siblingNames,
  onCommit,
  onCancel,
  isNew = false,
  allowAnyCharacters = false,
  ariaLabel = "Name",
}: RenameInputProps) {
  void _isFolder;
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const committedOrCancelled = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const r = validateRename(value, siblingNames, { allowAnyCharacters });
    setError(r.valid ? undefined : r.error);
  }, [value, siblingNames, allowAnyCharacters]);

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
  }, []);

  const commit = useCallback(async () => {
    if (committedOrCancelled.current) return;
    if (value === initialValue && value !== "") {
      if (!isNew) {
        committedOrCancelled.current = true;
        onCancel();
        return;
      }
      // isNew=true: fall through to commit the placeholder name
    }
    const r = validateRename(value, siblingNames, { allowAnyCharacters });
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
  }, [value, initialValue, siblingNames, onCommit, onCancel, isNew, allowAnyCharacters]);

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
        aria-label={ariaLabel}
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
