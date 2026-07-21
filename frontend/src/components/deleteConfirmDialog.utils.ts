/**
 * DeleteConfirmDialog data shapes + copy builder (D-26, UI-SPEC §7
 * Copywriting Contract).
 *
 * Every delete entry point (tree menu single-target, tree bulk-selection,
 * the ⌫ keyboard shortcut, and Plan 09's note-options menu) renders the
 * SAME <DeleteConfirmDialog> against `buildDeleteCopy(target)` so no call
 * site duplicates the locked strings — the dialog derives title/body/
 * confirm-label from `target` internally (D-26's "generalization"
 * requirement).
 *
 * Extracted so the component file only exports React components, which
 * satisfies react-refresh/only-export-components and keeps Fast Refresh.
 */

export type DeleteTarget =
  | { kind: "note"; name: string; id: string }
  | {
      kind: "folder";
      name: string;
      path: string;
      noteCount: number;
      subfolderCount: number;
    }
  | { kind: "multi"; count: number }
  | { kind: "file"; name: string; path: string };

export interface DeleteCopy {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * Locked copy per the Copywriting Contract (Phase 30 UI-SPEC §7, D-26):
 * note/folder/bulk deletes move the target to Trash — Phase 14's
 * soft-delete-to-`.trash/` behavior is unchanged underneath; this dialog
 * only gates the UI trigger (the ⌫ shortcut now opens this dialog instead
 * of deleting immediately).
 *
 * `file` targets (vault attachments, e.g. images dropped into an
 * attachments/ folder) have no `.trash/` path on the backend — FileStore
 * hard-deletes them (`fsstore.Store.DeleteFile`, not `TrashFile`) — so that
 * variant keeps copy describing an immediate, non-restorable delete rather
 * than a Trash promise the backend can't keep for this kind.
 */
export function buildDeleteCopy(target: DeleteTarget): DeleteCopy {
  switch (target.kind) {
    case "note":
      return {
        title: "Delete note?",
        body: `"${target.name}" will be moved to Trash. You can restore it from Trash later.`,
        confirmLabel: "Delete",
      };
    case "folder":
      return {
        title: "Delete folder?",
        body: `"${target.name}" and everything inside it will be moved to Trash. You can restore it from Trash later.`,
        confirmLabel: "Delete",
      };
    case "multi":
      return {
        title: `Delete ${target.count} notes?`,
        body: "They will be moved to Trash. You can restore them from Trash later.",
        confirmLabel: `Delete ${target.count} notes`,
      };
    case "file":
      return {
        title: "Delete this file?",
        body: `"${target.name}" will be deleted immediately. This cannot be undone.`,
        confirmLabel: "Delete file",
      };
  }
}
