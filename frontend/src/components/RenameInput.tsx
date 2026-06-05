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
 * Gap R2-5 — same-name commit is a no-op:
 * If the user presses Enter / Tab / clicks outside without changing
 * the value (or types a new value and erases back to the original),
 * RenameInput calls onCancel (NOT onCommit). This prevents a
 * 409 case-collision against the row's own current path — the
 * server's Service.Move does not short-circuit oldRelPath ==
 * canonNew, and FileStore's collision check then rejects the rename
 * even though it's a no-op (research §3.4). Symmetric to Plan 03-11's
 * computeMoveTarget same-parent guard for the drag path.
 *
 * Bug D / isNew exception to Gap R2-5:
 * When isNew=true (the node was just created and has an auto-generated
 * placeholder name), pressing Enter/Tab/blur without changing the
 * placeholder must COMMIT (keep the file with the placeholder name)
 * rather than cancel. The Gap R2-5 short-circuit only routes to
 * onCancel for established-file renames (isNew falsy). For isNew nodes
 * Escape still cancels (and TreeRow.handleCancelRename then deletes the
 * ephemeral node), but Enter/Tab/blur-without-change now correctly
 * commits the placeholder so the file is kept.
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


import { validateRename } from "./renameInput.utils";

export interface RenameInputProps {
  initialValue: string;
  isFolder: boolean;
  siblingNames: string[];
  onCommit: (newValue: string) => Promise<void>;
  onCancel: () => void;
  /**
   * Bug D fix — true when this rename was triggered by a create action
   * (the node was just created and the placeholder name was never confirmed
   * by the user). Affects the Gap R2-5 same-name short-circuit in commit():
   *   - isNew=false (default): Enter/Tab/blur without change → onCancel
   *     (the server would 409 on a same-path move anyway; this is a no-op
   *     dismiss, not a delete).
   *   - isNew=true: Enter/Tab/blur without change → onCommit(initialValue)
   *     (the user accepted the auto-generated placeholder name; keep the
   *     file). Escape still routes to onCancel (TreeRow.handleCancelRename
   *     then deletes the ephemeral node when isNew is set).
   */
  isNew?: boolean;
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
    const r = validateRename(value, siblingNames);
    setError(r.valid ? undefined : r.error);
  }, [value, siblingNames]);

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
      // isNew=true: fall through to onCommit(value) below so the
      // placeholder name is accepted and the file is kept.
    }
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
  }, [value, initialValue, siblingNames, onCommit, onCancel, isNew]);

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
      // For all other keys (alphanumeric, etc.) we let the input's
      // default behavior insert the character — propagation is already
      // stopped above, so the tree's keymap never sees it.
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
