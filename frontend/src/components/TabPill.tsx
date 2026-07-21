/**
 * TabPill — a single editor tab: file icon, title (truncated), an
 * always-visible close (X), middle-click close, and a "(deleted)" read-only
 * indicator.
 *
 * Pure props-in / callbacks-out. TabStrip owns pointer-event drag-to-reorder;
 * this pill only carries selection and close callbacks. Active styling uses
 * brighter title color (fg-title vs muted) and a 2px accent top-border; the
 * background is flush with the tab bar (--color-surface) for inactive pills,
 * --color-bg (matches the editor column) for the active pill.
 *
 * forwardRef: ContextMenu.Trigger asChild clones this element and injects its
 * own ref + handlers (onPointerDown, onContextMenu). Without forwardRef the
 * injected ref is silently dropped. Explicit handlers spread AFTER {...rest} so
 * our select handler always wins over Radix-injected same-key props; Radix's
 * context-menu-specific handlers (distinct keys) pass through untouched.
 */
import { useState, forwardRef } from "react";
import type { CSSProperties, HTMLAttributes } from "react";
import { X, FileText, Pin } from "lucide-react";
import { MIN_TAB_WIDTH, MAX_TAB_WIDTH } from "../lib/tabOverflow";

export interface TabPillProps {
  title: string;
  isActive: boolean;
  /**
   * Whether this pill's leaf is the active pane (WS-07 / D-05). The active
   * tab's 2px top-accent reads purple (--color-accent) when its pane is
   * active, and a neutral gray (--color-muted) when it is not — so the purple
   * accent itself is the active-PANE signal. Defaults true so single-pane /
   * non-LeafPane callers keep the original purple accent.
   */
  paneActive?: boolean;
  isDeleted: boolean;
  onSelect: () => void;
  onClose: () => void;
  /** Dim the pill while it is being dragged. NOT forwarded to the DOM. */
  isDragging?: boolean;
  /**
   * Pinned tabs (D-14/D-15, Phase 30): the trailing close-× slot renders a
   * Pin glyph instead. Defaults false so every pre-existing caller keeps the
   * original close-× behavior unchanged.
   */
  isPinned?: boolean;
  /** Fired when the pin glyph is clicked directly — refuses the close and
   *  surfaces a toast, rather than closing the tab. Required when isPinned. */
  onPinnedClickRefused?: () => void;
}

// Passthrough: arbitrary DOM attributes Radix injects (onPointerDown, onContextMenu,
// data-radix-*, etc.). Keys already in TabPillProps are excluded so our handlers win.
type TabPillAllProps = TabPillProps &
  Omit<HTMLAttributes<HTMLDivElement>, keyof TabPillProps>;

const tabPillStyle: CSSProperties = {
  height: 40,
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
  borderRadius: 0,
  borderRight: "1px solid var(--color-border-inner)",
  cursor: "pointer",
  // Prevent text selection on drag across tabs.
  userSelect: "none",
  WebkitUserSelect: "none",
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
  // Bottom-pin so the X center sits 16px above the strip bottom (6 + 20/2),
  // co-centered with the new-tab + and overflow chevron (both 24px buttons
  // bottom-pinned with 4px margin → 16px). Independent of the active pill's
  // 2px accent top-border, which would otherwise shift a center-aligned X.
  // (UAT-15.1-ALIGN 3-way co-centering contract.)
  alignSelf: "flex-end",
  marginBottom: 6,
};

export const TabPill = forwardRef<HTMLDivElement, TabPillAllProps>(
  function TabPill(
    {
      title,
      isActive,
      paneActive = true,
      isDeleted,
      onSelect,
      onClose,
      isDragging = false,
      isPinned = false,
      onPinnedClickRefused,
      ...rest
    },
    ref,
  ) {
    const [hovering, setHovering] = useState(false);

    // Active-tab top-accent color (D-05): purple in the active pane, neutral
    // gray in an inactive pane — the purple is the active-PANE signal.
    const activeAccentColor = paneActive
      ? "var(--color-accent)"
      : "var(--color-muted)";

    // Active: seated on the editor column below (--color-bg). Hovered inactive:
    // accent tint over the flush base. Idle inactive: flush with the tab bar
    // itself (--color-surface) — no separate "pill" surface color.
    const background = isActive
      ? "var(--color-bg)"
      : hovering
        ? "color-mix(in srgb, var(--color-accent) 12%, var(--color-surface))"
        : "var(--color-surface)";

    // Icon/title share the same color branch; deleted tabs always read destructive.
    const iconColor = isDeleted
      ? "var(--color-destructive)"
      : isActive
        ? "var(--color-fg-title)"
        : "var(--color-muted)";

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
          borderTop: isActive
            ? `2px solid ${activeAccentColor}`
            : "2px solid transparent",
          // Dim while dragging so the ghost is clearly the moving element.
          opacity: isDragging ? 0.4 : undefined,
        }}
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
        <FileText size={14} aria-hidden="true" style={{ flexShrink: 0, color: iconColor }} />
        {isDeleted ? (
          <span style={{ ...titleStyle, color: "var(--color-destructive)" }}>
            (deleted)
          </span>
        ) : (
          <span
            style={{
              ...titleStyle,
              // Active brighter-not-bolder: color conveys selection, weight is uniform.
              color: isActive ? "var(--color-fg-title)" : "var(--color-muted)",
            }}
          >
            {title}
          </span>
        )}
        {isPinned ? (
          <button
            type="button"
            aria-label="Pinned tab — right-click to unpin"
            title="Pinned tab"
            onClick={(e) => {
              // stopPropagation so the refuse-click never also selects the tab.
              e.stopPropagation();
              onPinnedClickRefused?.();
            }}
            style={closeButtonStyle}
          >
            <Pin size={12} aria-hidden="true" />
          </button>
        ) : (
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
        )}
      </div>
    );
  },
);

TabPill.displayName = "TabPill";
