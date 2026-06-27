/**
 * FlushConfirmDialog — Radix AlertDialog shown only when an on-close flush save
 * fails (TAB-13 / D-04). Two choices: "Keep editing" (cancel, also the Escape
 * resolution) or "Close without saving" (destructive). Body shows only the
 * filename — never the note content or raw server error (T-15-09).
 */
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type React from "react";

export interface FlushConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filename: string;
  onKeepEditing: () => void;
  onCloseWithoutSaving: () => void;
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

export function FlushConfirmDialog({
  open,
  onOpenChange,
  filename,
  onKeepEditing,
  onCloseWithoutSaving,
}: FlushConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay style={overlayStyle} />
        <AlertDialog.Content style={contentStyle}>
          <AlertDialog.Title style={titleStyle}>
            Save failed — close anyway?
          </AlertDialog.Title>
          <AlertDialog.Description style={bodyLineStyle}>
            Changes to {filename} could not be saved. Close this tab without
            saving, or keep it open to retry?
          </AlertDialog.Description>
          <div style={actionsRowStyle}>
            <AlertDialog.Cancel asChild>
              <button type="button" style={cancelBtnStyle} onClick={onKeepEditing}>
                Keep editing
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                style={confirmBtnStyle}
                onClick={onCloseWithoutSaving}
              >
                Close without saving
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
