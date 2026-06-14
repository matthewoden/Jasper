/**
 * DeleteConfirmDialog — Radix AlertDialog for note/folder/file/multi deletion.
 *
 * Confirm button uses bg-destructive because deletion is irreversible.
 */
import * as AlertDialog from "@radix-ui/react-alert-dialog";


import { buildFolderBody } from "./deleteConfirmDialog.utils";
import type { DeleteTarget } from "./deleteConfirmDialog.utils";

export interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: DeleteTarget;
  onConfirm: () => Promise<void>;
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
  let title: string;
  let confirmLabel: string;
  if (target.kind === "note") {
    title = "Delete this note?";
    confirmLabel = "Delete note";
  } else if (target.kind === "folder") {
    title = "Delete this folder?";
    confirmLabel = "Delete folder";
  } else if (target.kind === "multi") {
    title = `Delete ${target.count} items?`;
    confirmLabel = `Delete ${target.count} items`;
  } else if (target.kind === "file") {
    title = "Delete this file?";
    confirmLabel = "Delete file";
  } else {
    title = "Delete?";
    confirmLabel = "Delete";
  }

  let line1 = "";
  let line2 = "";
  let line2IsDestructive = false;
  if (target.kind === "note") {
    line1 = `${target.name} will be permanently removed from disk and from the index.`;
    line2 =
      "Your other notes are not touched — only this file is affected.";
    line2IsDestructive = false;
  } else if (target.kind === "folder") {
    const body = buildFolderBody(
      target.name,
      target.noteCount,
      target.subfolderCount,
    );
    line1 = body.line1;
    line2 = body.line2;
    line2IsDestructive = body.line2IsDestructive;
  } else if (target.kind === "multi") {
    line1 = `This will permanently delete the selected ${target.count} items from disk and from the index.`;
    line2 = "This cannot be undone.";
    line2IsDestructive = true;
  } else if (target.kind === "file") {
    line1 = `${target.name} will be permanently removed from disk.`;
    line2 = "This cannot be undone.";
    line2IsDestructive = true;
  }

  const handleConfirm = async (e: React.MouseEvent) => {
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
