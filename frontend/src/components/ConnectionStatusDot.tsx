import type { CSSProperties } from "react";
import { useTreeStore, type ConnectionStatus } from "../lib/useTreeStore";

/**
 * TREE-12 — connection-status dot for the sidebar toolbar.
 *
 *   green  = connected
 *   amber  = reconnecting / connecting
 *
 * Pure presentational. Reads useTreeStore.connectionStatus (transient
 * field, never persisted). Phase 4 D-04 says retry-forever, so there
 * is no "red / failed" state — amber persists until reconnect succeeds.
 *
 * Native <span title=...> tooltip per the SidebarToolbar Phase-1
 * deferral pattern (no Radix Tooltip in Phase 4).
 *
 * SECURITY (T-04-03): renders only a 3-value enum ("connecting" |
 * "connected" | "reconnecting") — never the raw origin_session_id.
 */
const COLORS: Record<ConnectionStatus, string> = {
  connected: "var(--color-success, #22c55e)",
  connecting: "var(--color-warning, #f59e0b)",
  reconnecting: "var(--color-warning, #f59e0b)",
};

const TITLES: Record<ConnectionStatus, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
};

export function ConnectionStatusDot() {
  const status = useTreeStore((s) => s.connectionStatus);
  const style: CSSProperties = {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    backgroundColor: COLORS[status],
  };
  return (
    <span
      role="status"
      aria-label={`Connection: ${status}`}
      title={TITLES[status]}
      data-testid="connection-status-dot"
      data-status={status}
      style={style}
    />
  );
}
