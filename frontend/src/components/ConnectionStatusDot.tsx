import type { CSSProperties } from "react";
import { useTreeStore, type ConnectionStatus } from "../lib/useTreeStore";
import { Tooltip } from "./Tooltip";

/**
 * ConnectionStatusDot — green/amber dot, leftmost in the StatusBar.
 *
 * Retry-forever means there is no red/failed state — amber persists until
 * reconnect succeeds. Renders only a 3-value enum, never the session ID.
 *
 * Phase 31 UAT #2: treated as an icon-tier control now — a 24x24/padding-4
 * footprint matching the other status-bar icon buttons (StatusBar.tsx's
 * zenButtonBase / SettingsMenu's buttonBase), wrapped in the shared Tooltip
 * (native `title` dropped, same Tooltip-migration every other icon control
 * got this phase). StatusBar centers this footprint inside a 48px-wide
 * column so the dot lines up under the left-rail ribbon's icon column.
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

const footprintStyle: CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

export function ConnectionStatusDot() {
  const status = useTreeStore((s) => s.connectionStatus);
  const dotStyle: CSSProperties = {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    backgroundColor: COLORS[status],
  };
  return (
    <Tooltip label={TITLES[status]}>
      <span style={footprintStyle}>
        <span
          role="status"
          aria-label={`Connection: ${status}`}
          data-testid="connection-status-dot"
          data-status={status}
          style={dotStyle}
        />
      </span>
    </Tooltip>
  );
}
