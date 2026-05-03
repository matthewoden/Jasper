/**
 * DeleteConfirmDialog — UI-SPEC §Surface 4.
 *
 * Radix AlertDialog with locked copy variants for note vs. folder
 * deletion. Reuses Phase 2's chrome (overlay 0.6 black, dialog
 * max-width 480, padding 24, etc.) but the Confirm button uses
 * bg-destructive instead of Phase 2's bg-accent (deletion is
 * irreversible — the only filled-destructive surface in Phases 1–3).
 *
 * Pluralization rules (locked):
 *   - 1 note → "1 note"; >1 → "{N} notes"; 0 → drop the clause
 *   - 1 subfolder → "1 subfolder"; >1 → "{M} subfolders"; 0 → drop
 *   - 0 of both → render the empty-folder reassurance copy instead
 */
import * as AlertDialog from "@radix-ui/react-alert-dialog";

export type DeleteTarget =
  | { kind: "note"; name: string }
  | {
      kind: "folder";
      name: string;
      noteCount: number;
      subfolderCount: number;
    };

export interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: DeleteTarget;
  onConfirm: () => Promise<void>;
}

/**
 * Returns "1 note" / "{N} notes" / null (when n === 0).
 */
function pluralize(n: number, one: string, many: string): string | null {
  if (n === 0) return null;
  if (n === 1) return `1 ${one}`;
  return `${n} ${many}`;
}

interface FolderBody {
  line1: string;
  line2: string;
  line2IsDestructive: boolean;
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

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.6)",
};

const contentStyle: React.CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  maxWidth: 480,
  width: "calc(100vw - 48px)",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  padding: 24,
  color: "var(--color-fg)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "var(--color-fg)",
  margin: 0,
  lineHeight: 1.4,
};

const bodyLineStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-fg)",
  lineHeight: 1.5,
  marginTop: 16,
};

const bodyLine2Style: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-fg)",
  lineHeight: 1.5,
  marginTop: 12,
};

const destructiveLine2Style: React.CSSProperties = {
  ...bodyLine2Style,
  color: "var(--color-destructive)",
};

const actionsRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 24,
};

const cancelBtnStyle: React.CSSProperties = {
  height: 32,
  padding: "0 12px",
  background: "transparent",
  color: "var(--color-fg)",
  border: "1px solid var(--color-border)",
  borderRadius: 4,
  fontSize: 14,
  fontFamily: "inherit",
  cursor: "pointer",
};

const confirmBtnStyle: React.CSSProperties = {
  height: 32,
  padding: "0 12px",
  background: "var(--color-destructive)",
  color: "var(--color-bg)",
  border: "none",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
};

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  target,
  onConfirm,
}: DeleteConfirmDialogProps) {
  const isNote = target.kind === "note";
  const title = isNote ? "Delete this note?" : "Delete this folder?";
  const confirmLabel = isNote ? "Delete note" : "Delete folder";

  let line1 = "";
  let line2 = "";
  let line2IsDestructive = false;
  if (target.kind === "note") {
    line1 = `${target.name} will be permanently removed from disk and from the index.`;
    line2 =
      "Your other notes are not touched — only this file is affected.";
    line2IsDestructive = false;
  } else {
    const body = buildFolderBody(
      target.name,
      target.noteCount,
      target.subfolderCount,
    );
    line1 = body.line1;
    line2 = body.line2;
    line2IsDestructive = body.line2IsDestructive;
  }

  const handleConfirm = async (e: React.MouseEvent) => {
    // Keep the dialog mounted while the async onConfirm resolves —
    // the parent closes via setDeleteTarget(null) on success.
    e.preventDefault();
    await onConfirm();
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay style={overlayStyle} />
        <AlertDialog.Content style={contentStyle}>
          <AlertDialog.Title style={titleStyle}>{title}</AlertDialog.Title>
          <AlertDialog.Description style={bodyLineStyle}>
            {line1}
          </AlertDialog.Description>
          <div
            style={
              line2IsDestructive ? destructiveLine2Style : bodyLine2Style
            }
          >
            {line2}
          </div>
          <div style={actionsRowStyle}>
            <AlertDialog.Cancel asChild>
              <button type="button" style={cancelBtnStyle}>
                Cancel
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                onClick={handleConfirm}
                style={confirmBtnStyle}
              >
                {confirmLabel}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
