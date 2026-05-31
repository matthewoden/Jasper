/**
 * StatusBar — Phase 6.6 Plan 10 / Plan 07-38 restored SaveIndicator-button
 * after UAT-4 N9 user reversal of UAT-3 N9 decision.
 *
 * Layout (left-to-right):
 *   [ConnectionStatusDot] [flex:1 spacer] [SaveIndicator-button] [SettingsMenu]
 *
 * The SaveIndicator was originally hoisted into the StatusBar by Plan 07-28
 * (B3 / UAT-2 N9), then moved to TopBar by Plan 07-37 (UAT-3 N9 / D-55), and
 * is now restored to StatusBar by Plan 07-38 (UAT-4 N9 / D-56).
 *
 * D-55's "click = manual reindex" merge behavior is PRESERVED — clicking
 * the SaveIndicator triggers postAdminReindex('incremental') exactly as it
 * did in TopBar. Only the mount location has reverted.
 *
 * The standalone "Reindex notes" refresh button (Plan 06.6) stays REMOVED
 * — D-55's merger is intact; the SaveIndicator now plays both roles
 * (state display + manual refresh trigger).
 */
import { useCallback } from "react";
import type { CSSProperties } from "react";
import { useTreeStore } from "../lib/useTreeStore";
import { useVaultPicker } from "../lib/useVaultPicker";
import { postAdminReindex } from "../lib/adminApi";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { SaveIndicator } from "./SaveIndicator";
import { SettingsMenu } from "./SettingsMenu";
import { VaultPicker } from "./VaultPicker";

const statusBarStyle: CSSProperties = {
  background: "var(--color-surface)",
  borderTop: "1px solid var(--color-border)",
  zIndex: 10,
  height: 32,
  padding: "0 8px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexShrink: 0,
};

export function StatusBar() {
  // Plan 07-38 (UAT-4 N9): subscribe to the hoisted saveState slice (still
  // populated by the autosave + lifecycle machinery — Plan 07-28 hoist
  // STAYS, only the mount location reverts).
  const saveState = useTreeStore((s) => s.saveState);

  // Plan 08-17c: vault picker state — shows current vault display_name segment.
  const { current, open } = useVaultPicker();

  // Plan 07-38 (UAT-4 N9): same handler the TopBar mount used. Manual
  // incremental reindex on click; the SaveIndicator-as-button mode
  // DoS-guards by disabling itself while saving (T-37-01 inside the
  // SaveIndicator component).
  //
  // UAT-2 R4-2: when saveState.status === "paused" (WS is down), the
  // click now triggers an immediate WS reconnect attempt instead of a
  // doomed reindex POST. The reindex would always fail because the
  // server is the same thing that owns the WS — if WS is down, the
  // HTTP listener is too. forceWsReconnect short-circuits the backoff
  // timer so the user doesn't have to wait up to 45s after a restart.
  const forceWsReconnect = useTreeStore((s) => s.forceWsReconnect);
  const handleRefresh = useCallback(async () => {
    if (saveState.status === "paused") {
      forceWsReconnect();
      return;
    }
    try {
      await postAdminReindex("incremental");
    } catch (err) {
      console.warn("[StatusBar] SaveIndicator-button refresh failed:", err);
    }
  }, [saveState.status, forceWsReconnect]);

  return (
    <footer style={statusBarStyle} data-testid="status-bar" aria-label="Status bar">
      <ConnectionStatusDot />
      {/* Plan 08-17c (V7): vault display_name segment; click opens the picker in switch mode */}
      {current && (
        <button
          type="button"
          className="status-bar__vault"
          onClick={open}
          title="Click to switch vault"
          data-testid="status-bar-vault"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--color-muted)",
            fontSize: 12,
            cursor: "pointer",
            padding: "0 4px",
          }}
        >
          {current.display_name}
        </button>
      )}
      <div style={{ flex: 1 }} data-testid="status-bar-spacer" />
      <SaveIndicator state={saveState} onClick={handleRefresh} />
      <SettingsMenu />
      {/* Plan 08-17c: VaultPicker in switch mode — persistent modal, controlled by useTreeStore.vaultPickerOpen */}
      <VaultPicker mode="switch" />
    </footer>
  );
}
