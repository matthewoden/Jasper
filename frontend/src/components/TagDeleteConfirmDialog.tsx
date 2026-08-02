/**
 * Shown only when N > 5 notes carry the tag; the caller deletes silently for N ≤ 5.
 */
import * as AlertDialog from "@radix-ui/react-alert-dialog";

export interface TagDeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tagName: string;
  noteCount: number;
  onConfirm: () => void;
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

const destructiveLine2Style: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-destructive)",
  lineHeight: 1.5,
  marginTop: 12,
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

export function TagDeleteConfirmDialog({
  open,
  onOpenChange,
  tagName,
  noteCount,
  onConfirm,
}: TagDeleteConfirmDialogProps) {
  const handleConfirm = (e: React.MouseEvent) => {
    e.preventDefault();
    onConfirm();
    onOpenChange(false);
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay style={overlayStyle} />
        <AlertDialog.Content style={contentStyle}>
          <AlertDialog.Title style={titleStyle}>
            {`Remove tag '${tagName}'?`}
          </AlertDialog.Title>
          <AlertDialog.Description style={bodyLineStyle}>
            {`This will remove "${tagName}" from ${noteCount} notes. Their frontmatter will be rewritten.`}
          </AlertDialog.Description>
          <div style={destructiveLine2Style}>This cannot be undone.</div>
          <div style={actionsRowStyle}>
            <AlertDialog.Cancel asChild>
              <button type="button" style={cancelBtnStyle}>
                Keep tag
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                onClick={handleConfirm}
                style={confirmBtnStyle}
              >
                Remove tag
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
