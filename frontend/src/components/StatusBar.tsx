/**
 * StatusBar — Phase 6.6 Plan 10 / simplified by Plan 07-37 (UAT-3 N9 / D-55).
 *
 * Layout (left-to-right):
 *   [ConnectionStatusDot] [flex:1 spacer] [SettingsMenu]
 *
 * Plan 07-37 removes:
 *   - The standalone "Reindex notes" refresh button (Plan 06.6).
 *   - The SaveIndicator that Plan 07-28 hoisted into this footer (B3 /
 *     UAT-2 N9).
 *
 * Both are unified into the SaveIndicator-as-refresh-button hybrid that now
 * lives in TopBar's right cluster (see SaveIndicator.tsx button mode and
 * TopBar.tsx mount). The `useTreeStore.saveState` slice (Plan 07-28) STAYS;
 * TopBar reads it instead of StatusBar.
 *
 * The StatusBar metadata zone (Phase 06.6 D-07) is reclaimed for v2 use.
 */
import type { CSSProperties } from "react";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { SettingsMenu } from "./SettingsMenu";

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
  return (
    <footer style={statusBarStyle} data-testid="status-bar" aria-label="Status bar">
      <ConnectionStatusDot />
      <div style={{ flex: 1 }} data-testid="status-bar-spacer" />
      <SettingsMenu />
    </footer>
  );
}
