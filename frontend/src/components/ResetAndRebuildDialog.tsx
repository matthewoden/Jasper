/**
 * Reset-and-Rebuild Confirmation dialog (Radix AlertDialog, role="alertdialog").
 *
 * The action is non-destructive — SQLite is rebuilt from .md files — so the
 * voice is reassuring. Opens/closes via controlled `open` + `onOpenChange` props.
 */

import * as AlertDialog from "@radix-ui/react-alert-dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function ResetAndRebuildDialog({ open, onOpenChange, onConfirm }: Props) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.6)",
          }}
        />
        <AlertDialog.Content
          style={{
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
          }}
        >
          <AlertDialog.Title
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: "var(--color-fg)",
              margin: 0,
              lineHeight: 1.4,
            }}
          >
            Reset the database?
          </AlertDialog.Title>
          <AlertDialog.Description
            style={{
              fontSize: 14,
              color: "var(--color-fg)",
              lineHeight: 1.5,
              marginTop: 16,
            }}
          >
            This drops the SQLite index and rebuilds it by reading every note
            file from disk. It can take up to a minute on a large vault.
          </AlertDialog.Description>
          <div
            style={{
              fontSize: 14,
              color: "var(--color-fg)",
              lineHeight: 1.5,
              marginTop: 12,
            }}
          >
            Your <code style={{ fontFamily: "var(--font-mono)" }}>.md</code>{" "}
            files are not touched — the filesystem is the source of truth. If
            anything goes wrong, your notes stay intact.
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 24,
            }}
          >
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                style={{
                  height: 32,
                  padding: "0 12px",
                  background: "transparent",
                  color: "var(--color-fg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 4,
                  fontSize: 14,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                Keep current schema
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                onClick={onConfirm}
                style={{
                  height: 32,
                  padding: "0 12px",
                  background: "var(--color-accent)",
                  color: "var(--color-bg)",
                  border: "none",
                  borderRadius: 4,
                  fontSize: 14,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                Reset and rebuild
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
