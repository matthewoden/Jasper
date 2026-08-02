/**
 * StatusBar — layout: [ConnectionStatusDot] [vault segment?] [word count?] [spacer] [SaveIndicator-button] [zen toggle]
 *
 * The duplicate Settings gear (SettingsMenu) that used to
 * sit at the far right was removed — ActivityRibbon's own gear is now the
 * sole Settings entry point (it keeps the `settings-menu-trigger` testid so
 * existing E2E selectors keep resolving).
 *
 * SaveIndicator doubles as a manual-reindex trigger — clicking it calls
 * postAdminReindex('incremental'). When paused (WebSocket offline), clicking
 * forces a WS reconnect instead.
 *
 * Word count: moved here from the editor's top-chrome
 * cluster — reflects the currently FOCUSED pane's note, not a sum across
 * split panes. `activeNoteId` already mirrors the active pane's active tab
 * (App.tsx's usePaneStore -> useTreeStore sync), so reading it here
 * gets split-pane-aware focus tracking for free. The note's live content
 * comes from its noteBufferController (one singleton per open note,
 * shared by every pane showing it) via the SAME subscribe/getContent
 * bridge EditorPane itself uses — updates on every keystroke in the
 * focused pane and re-targets automatically when focus moves panes.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { Focus } from "lucide-react";
import { getOrCreateController } from "../lib/noteBufferController";
import { useTreeStore } from "../lib/useTreeStore";
import { useVaultPicker } from "../lib/useVaultPicker";
import { postAdminReindex } from "../lib/adminApi";
import { countWords, formatWordCount } from "../lib/wordCount";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { SaveIndicator } from "./SaveIndicator";
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

// ActivityRibbon is a 48px-wide column flush against the
// window's left edge (App.tsx grid column 1), with every RibbonButton
// horizontally centered inside it (32px button in 48px column -> icon
// center at x=24). This wrapper mirrors that same 48px width so
// ConnectionStatusDot's icon footprint centers on the SAME x-column,
// lining the dot up vertically under the ribbon's icons. marginLeft
// cancels the footer's own 8px left padding so the column's left edge
// starts flush at x=0, matching the ribbon's own left edge.
const dotColumnStyle: CSSProperties = {
  width: 48,
  marginLeft: -8,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
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
  const activeNoteId = useTreeStore((s) => s.activeNoteId);

  const { current, open, refresh } = useVaultPicker();
  const setRefreshVaultCurrent = useTreeStore((s) => s.setRefreshVaultCurrent);

  useEffect(() => {
    setRefreshVaultCurrent(refresh);
  }, [refresh, setRefreshVaultCurrent]);

  // Focused-note word count: getOrCreateController is
  // idempotent — by the time activeNoteId points at a note, that note's own
  // EditorPane has already created (and keeps alive) its controller, so this
  // call just returns the SAME singleton rather than creating a duplicate.
  const activeController = activeNoteId !== null ? getOrCreateController(activeNoteId) : null;
  const subscribeActiveController = useCallback(
    (onStoreChange: () => void) => {
      if (!activeController) return () => {};
      return activeController.subscribe(onStoreChange);
    },
    [activeController],
  );
  const activeContent = useSyncExternalStore(
    subscribeActiveController,
    () => activeController?.getContent() ?? "",
  );
  const focusedWordCount = useMemo(
    () => (activeNoteId !== null ? countWords(activeContent) : null),
    [activeNoteId, activeContent],
  );

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
      <div style={dotColumnStyle} data-testid="status-bar-dot-column">
        <ConnectionStatusDot />
      </div>
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
      {/* Focused-note word count — hidden entirely when no
          pane has a note focused (blank state), rather than a placeholder. */}
      {focusedWordCount !== null && (
        <span
          data-testid="status-bar-word-count"
          style={{
            fontSize: 12,
            color: "var(--color-muted)",
            whiteSpace: "nowrap",
            padding: "0 4px",
          }}
        >
          {formatWordCount(focusedWordCount)}
        </span>
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
      {/* VaultPicker in switch mode — persistent modal */}
      <VaultPicker mode="switch" />
    </footer>
  );
}
