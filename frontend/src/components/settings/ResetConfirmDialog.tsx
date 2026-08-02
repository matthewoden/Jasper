/**
 * ResetConfirmDialog — destructive confirm gating a per-section config Reset
 * (SET3-02). Structural template: TagDeleteConfirmDialog.tsx (Root/Portal/
 * Overlay/Content/Title/Description/Cancel+Action). Diverges in geometry
 * (380px/20px) and copy (a single Title + single Description naming the
 * section only, never MCP write grants).
 *
 * KNOWN UNVERIFIED BEHAVIOR: this AlertDialog is designed to render while a
 * Settings Dialog.Root is still open. Radix documents nesting as supported,
 * but this codebase has no prior example and jsdom cannot assert focus-trap
 * handoff or Escape-key layering. Those two behaviors are owed to the
 * human-verify checkpoint in plan 32-11 — do not treat their absence here as
 * a gap in this component's own test coverage.
 */
import * as AlertDialog from "@radix-ui/react-alert-dialog";

export interface ResetConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sectionLabel: string;
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
  width: 380,
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  padding: 20,
  color: "var(--color-fg)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--color-fg)",
  margin: 0,
  lineHeight: 1.3,
};

const descriptionStyle: React.CSSProperties = {
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
  background: "var(--color-btn-secondary-bg)",
  border: "1px solid var(--color-btn-secondary-border)",
  color: "var(--color-btn-secondary-fg)",
  borderRadius: 4,
  fontSize: 14,
  fontFamily: "inherit",
  cursor: "pointer",
};

// Danger-styled — the same color-mix tint the
// existing save-error banner uses (10% bg / 40% border / full-strength text),
// not a solid fill. Reset is the ONLY control in this phase using --color-destructive.
const confirmBtnStyle: React.CSSProperties = {
  height: 32,
  padding: "0 12px",
  background: "color-mix(in srgb, var(--color-destructive) 10%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-destructive) 40%, transparent)",
  color: "var(--color-destructive)",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
};

export function ResetConfirmDialog({
  open,
  onOpenChange,
  sectionLabel,
  onConfirm,
}: ResetConfirmDialogProps) {
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
            {`Reset ${sectionLabel} to defaults?`}
          </AlertDialog.Title>
          <AlertDialog.Description style={descriptionStyle}>
            {"This can't be undone."}
          </AlertDialog.Description>
          <div style={actionsRowStyle}>
            <AlertDialog.Cancel asChild>
              <button type="button" style={cancelBtnStyle}>
                Cancel
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button type="button" onClick={handleConfirm} style={confirmBtnStyle}>
                Reset
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
