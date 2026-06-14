/**
 * DeleteConfirmDialog data shapes + body-text builder.
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

export interface FolderBody {
  line1: string;
  line2: string;
  line2IsDestructive: boolean;
}

/** Returns "1 note" / "{N} notes" / null (when n === 0). */
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
