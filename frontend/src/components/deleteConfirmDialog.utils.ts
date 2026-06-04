/**
 * DeleteConfirmDialog data shapes + body-text builder (UI-SPEC §Surface 4).
 *
 * Extracted from DeleteConfirmDialog.tsx so the component file only
 * exports React components — satisfies react-refresh/only-export-components
 * and restores Fast Refresh DX for the delete-confirmation dialog.
 */

// WR-09 (Phase 5.5 gap-closure Plan 13) — note + folder variants carry the
// canonical identifier (id for notes, path for folders) so
// FileTree.handleConfirmDelete can dispatch deletion without re-deriving
// the identifier from the display name (which is ambiguous when two
// siblings share a basename / display name across different subtrees,
// e.g. two `Foo.md` notes at root and `projects/Foo.md`).
export type DeleteTarget =
  | { kind: "note"; name: string; id: string }
  | {
      kind: "folder";
      name: string;
      path: string;
      noteCount: number;
      subfolderCount: number;
    }
  // UX-13 (Phase 5.5 Plan 07): batch delete variant — single confirmation
  // for N selected items. Copy is "Delete N items?" per the must-have
  // truth in the plan frontmatter. The body lists no per-row detail; the
  // batch is opaque from the dialog's perspective.
  | { kind: "multi"; count: number }
  // Plan 07-38 R7b: file rows (non-markdown attachments / generic files)
  // can now be deleted from the tree. Copy mirrors the note variant —
  // single-item destructive dialog — but the action dispatches through
  // filesApi.deleteFile instead of muts.deleteNote.
  | { kind: "file"; name: string; path: string };

export interface FolderBody {
  line1: string;
  line2: string;
  line2IsDestructive: boolean;
}

/**
 * Returns "1 note" / "{N} notes" / null (when n === 0).
 */
function pluralize(n: number, one: string, many: string): string | null {
  if (n === 0) return null;
  if (n === 1) return `1 ${one}`;
  return `${n} ${many}`;
}

export function buildFolderBody(
  name: string,
  noteCount: number,
  subfolderCount: number,
): FolderBody {
  const parts = [
    pluralize(noteCount, "note", "notes"),
    pluralize(subfolderCount, "subfolder", "subfolders"),
  ].filter(Boolean) as string[];
  if (parts.length === 0) {
    return {
      line1: `${name} will be permanently removed from disk and from the index.`,
      line2:
        "Your other notes are not touched — only this folder is affected.",
      line2IsDestructive: false,
    };
  }
  const contents =
    parts.length === 2 ? `${parts[0]} and ${parts[1]}` : parts[0];
  return {
    line1: `${name} contains ${contents}. All of them will be permanently removed from disk and from the index.`,
    line2: "This cannot be undone.",
    line2IsDestructive: true,
  };
}
