import { useCallback, useState } from "react";
import type { CSSProperties } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { SettingsMenu } from "./SettingsMenu";
import { postAdminReindex } from "../lib/adminApi";

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

const buttonBase: CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
};

export function StatusBar(): JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  const [hovering, setHovering] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await postAdminReindex("incremental");
    } catch {
      // App-level reindex error path handles UI feedback; status bar stays quiet.
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  return (
    <footer style={statusBarStyle} data-testid="status-bar" aria-label="Status bar">
      <ConnectionStatusDot />
      <button
        type="button"
        aria-label="Reindex notes"
        title="Reindex notes"
        onClick={handleRefresh}
        disabled={refreshing}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={{
          ...buttonBase,
          opacity: refreshing ? 0.5 : 1,
          cursor: refreshing ? "wait" : "pointer",
          background:
            !refreshing && hovering
              ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
              : "transparent",
        }}
      >
        {refreshing ? (
          <Loader2 size={14} aria-hidden="true" className="animate-spin" />
        ) : (
          <RefreshCw size={14} aria-hidden="true" />
        )}
      </button>
      <div style={{ flex: 1 }} data-testid="status-bar-spacer" />
      <SettingsMenu />
    </footer>
  );
}
