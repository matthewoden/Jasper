/**
 * PaneHeader — 56px fixed content-pane header (D-19 locked geometry). Left
 * cluster shows the active section's title + subtitle; right cluster holds
 * an optional neutral Reset and the Close control. About renders no Reset
 * (D-08) — `showReset` gates the button out of the DOM entirely, not a
 * disabled/greyed state.
 */
import { X } from "lucide-react";
import { Tooltip } from "../Tooltip";

export interface PaneHeaderProps {
  title: string;
  subtitle: string;
  showReset: boolean;
  onReset: () => void;
  onClose: () => void;
}

const resetButtonStyle: React.CSSProperties = {
  height: 28,
  padding: "0 12px",
  background: "var(--color-btn-secondary-bg)",
  color: "var(--color-btn-secondary-fg)",
  border: "1px solid var(--color-btn-secondary-border)",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  cursor: "pointer",
};

const closeButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  padding: 4,
  borderRadius: 4,
  display: "flex",
};

export function PaneHeader({ title, subtitle, showReset, onReset, onClose }: PaneHeaderProps) {
  return (
    <div
      style={{
        height: 56,
        flexShrink: 0,
        borderBottom: "1px solid var(--color-border)",
        padding: "0 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--color-fg-title)",
            flexShrink: 0,
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 400,
            color: "var(--color-muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          {subtitle}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {showReset && (
          <button type="button" onClick={onReset} style={resetButtonStyle}>
            Reset
          </button>
        )}
        <Tooltip label="Close settings">
          <button type="button" aria-label="Close settings" onClick={onClose} style={closeButtonStyle}>
            <X size={16} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
