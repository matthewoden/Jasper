/**
 * VaultSwitchOverlay — full-screen non-dismissable overlay shown while a vault
 * switch is in progress (vault.switching WS event). Unmounts when the SPA
 * reloads on vault.switched (or 10-second failsafe).
 *
 * role="dialog" + aria-modal="true" prevents screen readers from announcing
 * background content during the switch.
 */

export interface VaultSwitchOverlayProps {
  /** Display name of the target vault shown in the "Switching to…" message. */
  targetName: string;
}

export function VaultSwitchOverlay({ targetName }: VaultSwitchOverlayProps) {
  return (
    <div
      className="vault-switch-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Switching vault"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--color-bg, #1e1e1e)",
        color: "var(--color-text, #e0e0e0)",
      }}
    >
      <div className="vault-switch-overlay__inner" style={{ textAlign: "center" }}>
        <div
          className="vault-switch-overlay__spinner"
          aria-hidden="true"
          style={{
            width: 32,
            height: 32,
            border: "3px solid var(--color-border, #444)",
            borderTopColor: "var(--color-accent, #7c9ef8)",
            borderRadius: "50%",
            animation: "jasper-spin 0.8s linear infinite",
            margin: "0 auto 16px",
          }}
        />
        <div className="vault-switch-overlay__msg">
          Switching to {targetName}&hellip;
        </div>
      </div>
    </div>
  );
}
