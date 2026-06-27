/**
 * ChromeBar — the single editor-column chrome row.
 *
 * Layout: [sidebar-toggle] {children: TabStrip} [PanelSelectorDropdown + right-rail-toggle]
 *
 * Replaces the old TopBar+TabStrip two-row stack: the breadcrumb moved onto the
 * active tab pill, so the chrome collapses to one row. The row is `align-items:
 * flex-end` with a 4px bottom margin on every flanking control, so a 24px button
 * centers at ~16px from the row bottom — matching the 32px pills' center, nothing
 * floating high above the tabs.
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { PanelSelectorDropdown } from "./PanelSelectorDropdown";

const chromeBarStyle: CSSProperties = {
  background: "var(--color-bg)",
  borderBottom: "1px solid var(--color-border)",
  zIndex: 10,
  height: 36,
  padding: "0 8px",
  display: "flex",
  alignItems: "flex-end",
  gap: 4,
  flexShrink: 0,
};

const buttonBase: CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
  // Bottom-align with the 32px pills on a flex-end row.
  marginBottom: 4,
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
};

interface ToggleButtonProps {
  ariaLabel: string;
  onClick: () => void;
  icon: React.ReactNode;
}

function ToggleButton({
  ariaLabel,
  onClick,
  icon,
}: ToggleButtonProps): React.JSX.Element {
  const [hovering, setHovering] = useState(false);
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        ...buttonBase,
        background: hovering
          ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
          : "transparent",
      }}
    >
      {icon}
    </button>
  );
}

export interface ChromeBarProps {
  /** The TabStrip slot — the flex:1 middle of the row. */
  children: React.ReactNode;
  /** Optional style override — typically used by App.tsx for grid placement. */
  style?: CSSProperties;
}

export function ChromeBar({ children, style }: ChromeBarProps): React.JSX.Element {
  const notesSidebarVisible = useTreeStore((s) => s.notesSidebarVisible);
  const setNotesSidebarVisible = useTreeStore((s) => s.setNotesSidebarVisible);
  const backlinksRailExpanded = useTreeStore((s) => s.backlinksRailExpanded);
  const setBacklinksRailExpanded = useTreeStore(
    (s) => s.setBacklinksRailExpanded,
  );
  const panelSelectorState = useTreeStore((s) => s.panelSelector);
  const anyPanelSelected =
    panelSelectorState.tags || panelSelectorState.backlinks;

  const sidebarLabel = notesSidebarVisible
    ? "Hide notes sidebar"
    : "Show notes sidebar";
  const railLabel = backlinksRailExpanded ? "Hide panels" : "Show panels";

  return (
    <div style={{ ...chromeBarStyle, ...style }} data-testid="chrome-bar">
      <ToggleButton
        ariaLabel={sidebarLabel}
        onClick={() => setNotesSidebarVisible(!notesSidebarVisible)}
        icon={
          notesSidebarVisible ? (
            <ChevronLeft size={16} aria-hidden="true" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" />
          )
        }
      />

      {/* TabStrip slot — the flex:1 middle. */}
      {children}

      {/* Right group: PanelSelectorDropdown (always present) + right-rail toggle
          (gated on panelSelector state). Both carry the 4px bottom margin so they
          bottom-align with the pills. */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 4,
          flexShrink: 0,
        }}
      >
        <span style={{ display: "inline-flex", marginBottom: 4 }}>
          <PanelSelectorDropdown />
        </span>
        {anyPanelSelected && (
          <ToggleButton
            ariaLabel={railLabel}
            onClick={() => setBacklinksRailExpanded(!backlinksRailExpanded)}
            icon={
              backlinksRailExpanded ? (
                <ChevronRight size={16} aria-hidden="true" />
              ) : (
                <ChevronLeft size={16} aria-hidden="true" />
              )
            }
          />
        )}
      </div>
    </div>
  );
}
