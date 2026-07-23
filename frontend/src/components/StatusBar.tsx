/**
 * StatusBar — layout: [ConnectionStatusDot] [vault segment?] [spacer] [SaveIndicator-button] [SettingsMenu]
 *
 * SaveIndicator doubles as a manual-reindex trigger — clicking it calls
 * postAdminReindex('incremental'). When paused (WebSocket offline), clicking
 * forces a WS reconnect instead.
 */
import { useCallback, useEffect } from "react";
import type { CSSProperties } from "react";
import { Focus } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { useVaultPicker } from "../lib/useVaultPicker";
import { postAdminReindex } from "../lib/adminApi";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { SaveIndicator } from "./SaveIndicator";
import { SettingsMenu } from "./SettingsMenu";
import { Tooltip } from "./Tooltip";
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

// Cloned from SettingsMenu's buttonBase (24x24 / padding 4, the StatusBar
// icon-button tier — NOT the 32px RibbonButton tier).
const zenButtonBase: CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
};

export function StatusBar() {
  const saveState = useTreeStore((s) => s.saveState);
  const zen = useTreeStore((s) => s.zen);
  const toggleZen = useTreeStore((s) => s.toggleZen);

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
        <Tooltip label="Click to switch vault" side="bottom">
          <button
            type="button"
            className="status-bar__vault"
            onClick={open}
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
        </Tooltip>
      )}
      <div style={{ flex: 1 }} data-testid="status-bar-spacer" />
      <SaveIndicator state={saveState} onClick={handleRefresh} />
      <Tooltip label="Zen mode" shortcut="⌘." side="bottom">
        <button
          type="button"
          aria-label="Toggle zen mode"
          data-testid="zen-toggle-button"
          style={{
            ...zenButtonBase,
            color: zen ? "var(--color-accent)" : "var(--color-muted)",
          }}
          onClick={() => toggleZen()}
        >
          <Focus size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <SettingsMenu />
      {/* VaultPicker in switch mode — persistent modal */}
      <VaultPicker mode="switch" />
    </footer>
  );
}
