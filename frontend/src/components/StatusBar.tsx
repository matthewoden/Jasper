/**
 * StatusBar — layout: [ConnectionStatusDot] [vault segment?] [spacer] [SaveIndicator-button] [SettingsMenu]
 *
 * SaveIndicator doubles as a manual-reindex trigger — clicking it calls
 * postAdminReindex('incremental'). When paused (WebSocket offline), clicking
 * forces a WS reconnect instead.
 */
import { useCallback, useEffect } from "react";
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
  const saveState = useTreeStore((s) => s.saveState);

  const { current, open, refresh } = useVaultPicker();
  const setRefreshVaultCurrent = useTreeStore((s) => s.setRefreshVaultCurrent);

  useEffect(() => {
    setRefreshVaultCurrent(refresh);
  }, [refresh, setRefreshVaultCurrent]);

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
      {/* Vault display_name; click opens vault picker in switch mode */}
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
      {/* VaultPicker in switch mode — persistent modal */}
      <VaultPicker mode="switch" />
    </footer>
  );
}
