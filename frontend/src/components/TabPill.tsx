/**
 * TabPill — a single editor tab: title (truncated), an always-visible close (X),
 * middle-click close, and a "(deleted)" read-only indicator.
 *
 * Pure props-in / callbacks-out. TabStrip (Plan 04) owns reorder logic and threads
 * the native HTML5 drag handlers; this pill only forwards them. Active styling is a
 * surface background + a 2px accent bottom-border underline; hover uses the shared
 * accent-12% tint.
 */
import { useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import { X } from "lucide-react";

export interface TabPillProps {
  title: string;
  isActive: boolean;
  isDeleted: boolean;
  /** Muted folder-path prefix; rendered only on the active, non-deleted pill. */
  breadcrumb?: string;
  onSelect: () => void;
  onClose: () => void;
  /** Native DnD handlers threaded from TabStrip (reorder lives there). */
  draggable?: boolean;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: DragEvent<HTMLDivElement>) => void;
}

const tabPillStyle: CSSProperties = {
  height: 32,
  minWidth: 80,
  maxWidth: 200,
  display: "flex",
  alignItems: "center",
  padding: "0 8px",
  gap: 4,
  borderRadius: "4px 4px 0 0",
  cursor: "pointer",
  flexShrink: 0,
};

const titleStyle: CSSProperties = {
  fontSize: 12,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  // Title wins: a far lower flexShrink than the breadcrumb (9999) means the
  // breadcrumb collapses first and the title ellipsizes only as a last resort.
  minWidth: 0,
};

/** Muted folder prefix shown before the active pill's title. Very high
 *  flexShrink so it disappears before the title truncates ("if only one fits,
 *  show the title"). */
const breadcrumbStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--color-muted)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
  flexShrink: 9999,
};

const closeButtonStyle: CSSProperties = {
  width: 20,
  height: 20,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--color-muted)",
  borderRadius: 2,
  flexShrink: 0,
};

export function TabPill({
  title,
  isActive,
  isDeleted,
  breadcrumb,
  onSelect,
  onClose,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
}: TabPillProps) {
  const [hovering, setHovering] = useState(false);

  const background = isActive
    ? "var(--color-surface)"
    : hovering
      ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
      : "transparent";

  return (
    <div
      role="tab"
      aria-selected={isActive}
      aria-label={isDeleted ? `${title} (deleted, read-only)` : undefined}
      style={{
        ...tabPillStyle,
        // The active pill gets extra room so the breadcrumb + title both fit.
        maxWidth: isActive ? 320 : 200,
        background,
        borderBottom: isActive
          ? "2px solid var(--color-accent)"
          : "2px solid transparent",
      }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onSelect}
      onAuxClick={(e) => {
        if (e.button === 1) {
          // Middle-click closes the tab (TAB-05 / D-14).
          e.preventDefault();
          onClose();
        }
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {isDeleted ? (
        <span style={{ ...titleStyle, color: "var(--color-destructive)" }}>
          (deleted)
        </span>
      ) : (
        <>
          {breadcrumb && isActive && (
            <span data-testid="tab-breadcrumb" style={breadcrumbStyle}>
              {breadcrumb} /
            </span>
          )}
          <span style={{ ...titleStyle, fontWeight: isActive ? 600 : 400 }}>
            {title}
          </span>
        </>
      )}
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={(e) => {
          // stopPropagation so closing the tab never also selects it.
          e.stopPropagation();
          onClose();
        }}
        style={closeButtonStyle}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
