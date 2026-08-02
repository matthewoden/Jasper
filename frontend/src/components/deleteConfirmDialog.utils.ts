/**
 * Every delete entry point renders the same dialog against buildDeleteCopy, so
 * no call site duplicates the locked strings.
 *
 * Split out of the component file so it exports only React components, which is
 * what keeps Fast Refresh working.
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
 * Locked copy. Note/folder/bulk deletes promise Trash, matching the backend's
 * soft delete.
 *
 * `file` targets do NOT: the backend hard-deletes attachments, so that variant
 * must describe a non-restorable delete rather than a Trash promise it cannot
 * keep.
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
