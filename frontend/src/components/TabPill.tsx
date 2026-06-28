/**
 * TabPill — a single editor tab: title (truncated), an always-visible close (X),
 * middle-click close, and a "(deleted)" read-only indicator.
 *
 * Pure props-in / callbacks-out. TabStrip (Plan 04) owns reorder logic and threads
 * the native HTML5 drag handlers; this pill only forwards them. Active styling is a
 * surface background + a 2px accent bottom-border underline; hover uses the shared
 * accent-12% tint. The note's folder breadcrumb lives at the top of the editor
 * content (EditorPane), not on the pill.
 *
 * forwardRef: ContextMenu.Trigger asChild clones this element and injects its own
 * ref + handlers (onPointerDown, onContextMenu). Without forwardRef the injected
 * ref is silently dropped and native DnD cannot initialise. Explicit handlers spread
 * AFTER {...rest} so our DnD/select handlers always win over Radix-injected same-key
 * props; Radix's context-menu-specific handlers (distinct keys) pass through untouched.
 */
import { useState, forwardRef } from "react";
import type { CSSProperties, DragEvent, HTMLAttributes } from "react";
import { X } from "lucide-react";
import { MIN_TAB_WIDTH, MAX_TAB_WIDTH } from "../lib/tabOverflow";

export interface TabPillProps {
  title: string;
  isActive: boolean;
  isDeleted: boolean;
  onSelect: () => void;
  onClose: () => void;
  /** Native DnD handlers threaded from TabStrip (reorder lives there). */
  draggable?: boolean;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: DragEvent<HTMLDivElement>) => void;
}

// Passthrough: arbitrary DOM attributes Radix injects (onPointerDown, onContextMenu,
// data-radix-*, etc.). Keys already in TabPillProps are excluded so our handlers win.
type TabPillAllProps = TabPillProps &
  Omit<HTMLAttributes<HTMLDivElement>, keyof TabPillProps>;

const tabPillStyle: CSSProperties = {
  height: 32,
  // Shrink-to-fit (TAB-16): pills flex DOWN to MIN_TAB_WIDTH so as many
  // ellipsized titles show as the strip allows; flexGrow:0 keeps them
  // left-aligned (Obsidian feel) rather than stretching to fill.
  minWidth: MIN_TAB_WIDTH,
  maxWidth: MAX_TAB_WIDTH,
  flexShrink: 1,
  flexGrow: 0,
  display: "flex",
  alignItems: "center",
  padding: "0 8px",
  gap: 4,
  borderRadius: "4px 4px 0 0",
  cursor: "pointer",
};

const titleStyle: CSSProperties = {
  fontSize: 12,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
  // flex:1 fills available width so the X button stays at the pill's right edge
  // in both normal and deleted states.
  flex: 1,
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

export const TabPill = forwardRef<HTMLDivElement, TabPillAllProps>(
  function TabPill(
    {
      title,
      isActive,
      isDeleted,
      onSelect,
      onClose,
      draggable,
      onDragStart,
      onDragOver,
      onDrop,
      ...rest
    },
    ref,
  ) {
    const [hovering, setHovering] = useState(false);

    // Active: brightest surface. Hovered inactive: accent tint over opaque base.
    // Idle inactive: surface-subtle (opaque, distinct from strip bg and active).
    const background = isActive
      ? "var(--color-surface)"
      : hovering
        ? "color-mix(in srgb, var(--color-accent) 12%, var(--color-surface-subtle))"
        : "var(--color-surface-subtle)";

    return (
      <div
        ref={ref}
        {...rest}
        role="tab"
        aria-selected={isActive}
        aria-label={isDeleted ? `${title} (deleted, read-only)` : undefined}
        style={{
          ...tabPillStyle,
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
          <span
            style={{
              ...titleStyle,
              // Active brighter-not-bolder: color conveys selection, weight is uniform.
              color: isActive ? "var(--color-fg)" : "var(--color-muted)",
            }}
          >
            {title}
          </span>
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
  },
);

TabPill.displayName = "TabPill";
