/**
 * TopBar — horizontal chrome strip.
 *
 * Layout: [sidebar-toggle + Breadcrumbs] [PanelSelectorDropdown + right-rail-toggle]
 *
 * var(--color-bg) background + var(--shadow-elevation-1) drop shadow so editor
 * content slips visually behind it on scroll. Optional style prop used by App.tsx
 * for grid placement.
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { Breadcrumbs } from "./Breadcrumbs";
import { PanelSelectorDropdown } from "./PanelSelectorDropdown";


const topBarStyle: CSSProperties = {
  background: "var(--color-bg)",
  boxShadow: "var(--shadow-elevation-1)",
  zIndex: 10,
  height: 40,
  padding: "0 8px",
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
};

const buttonBase: CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
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


export interface TopBarProps {
  /** Optional style override — typically used by App.tsx for grid placement. */
  style?: CSSProperties;
}

export function TopBar({ style }: TopBarProps): React.JSX.Element {
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
    <div
      style={{ ...topBarStyle, ...style }}
      data-testid="top-bar"
    >
      {/* Left group: sidebar toggle + breadcrumbs.
          4px inner gap → 8px outer pad + 24px toggle + 4px gap = 36px text-start,
          matching --editor-content-x. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          flex: 1,
          minWidth: 0,
        }}
      >
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
        <Breadcrumbs />
      </div>

      {/* Right group: PanelSelectorDropdown (always present) + right-rail
          toggle (gated on panelSelector state — hidden when no panel is selected,
          since there would be nothing to toggle). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          flexShrink: 0,
        }}
      >
        <PanelSelectorDropdown />
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
