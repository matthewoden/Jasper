/**
 * KeyboardShortcutsDialog — Cmd+/ cheat-sheet dialog. Plan 07-12.
 * UI-SPEC §Surface 6.
 *
 * Uses @radix-ui/react-dialog (NOT AlertDialog — this is non-destructive).
 * Width 560px, centered, padding 24px.
 * 2-column grid of grouped entries; each row: label left, KeyboardChip right.
 * Footer with locked tip copy. Close button (accent recipe).
 * Esc closes via Radix default.
 *
 * Forward-compat: KeyboardChip is imported from KeyboardChip.tsx — NEVER
 * re-implemented here (UI-SPEC §Forward-Compat #2).
 * All colors via var(--color-*) tokens; no hex literals.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { CHEAT_SHEET_ENTRIES, GROUP_ORDER } from "../lib/shortcutsRegistry";
import { KeyboardChip } from "./KeyboardChip";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function KeyboardShortcutsDialog({ open, onOpenChange }: Props) {
  // Group entries by group field, in GROUP_ORDER; omit empty groups.
  const grouped = GROUP_ORDER.map((g) => ({
    group: g,
    entries: CHEAT_SHEET_ENTRIES.filter((e) => e.group === g),
  })).filter((g) => g.entries.length > 0);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.6)",
          }}
        />
        <Dialog.Content
          aria-label="Keyboard shortcuts"
          aria-describedby={undefined}
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            maxWidth: 560,
            width: "calc(100vw - 48px)",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            padding: 24,
            color: "var(--color-fg)",
            overflowY: "auto",
            maxHeight: "calc(100vh - 48px)",
          }}
        >
          <Dialog.Title
            style={{
              fontSize: 16,
              fontWeight: 600,
              lineHeight: 1.4,
              margin: 0,
              color: "var(--color-fg)",
            }}
          >
            Keyboard shortcuts
          </Dialog.Title>

          {/* 2-column grid of grouped entries */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "24px 32px",
              marginTop: 16,
            }}
          >
            {grouped.map(({ group, entries }) => (
              <div key={group}>
                {/* Group eyebrow: 12px / 600 / muted / uppercase / 0.05em */}
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--color-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 8,
                  }}
                >
                  {group.toUpperCase()}
                </div>

                {entries.map((e) => (
                  <div
                    key={e.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 0",
                      fontSize: 14,
                      color: "var(--color-fg)",
                    }}
                  >
                    <span>{e.label}</span>
                    {e.shortcut ? (
                      <KeyboardChip>{e.shortcut}</KeyboardChip>
                    ) : (
                      <span style={{ color: "var(--color-muted)" }}>{"—"}</span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Locked footer — verbatim from UI-SPEC §Copywriting Contract */}
          <div
            style={{
              marginTop: 24,
              paddingTop: 16,
              borderTop: "1px solid var(--color-border)",
              fontSize: 12,
              color: "var(--color-muted)",
              lineHeight: 1.5,
            }}
          >
            {
              "Tip: ⌘P and ⌘O are intercepted by Jasper. To use the browser's open/print, use the browser menu instead."
            }
          </div>

          {/* Close button — accent recipe (matches ResetAndRebuildDialog.tsx) */}
          <div
            style={{
              marginTop: 24,
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              onClick={() => onOpenChange(false)}
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
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
