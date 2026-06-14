import type { CSSProperties } from "react";
import { useTreeStore, type ConnectionStatus } from "../lib/useTreeStore";

/**
 * ConnectionStatusDot — green/amber dot for the sidebar toolbar.
 *
 * Retry-forever means there is no red/failed state — amber persists until
 * reconnect succeeds. Renders only a 3-value enum, never the session ID.
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
