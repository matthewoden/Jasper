/**
 * TopBar — Phase 06.6-09 (UX-CHROME-01)
 *
 * Composed horizontal chrome strip occupying gridRow: 1, gridColumn: 2 of the
 * App.tsx two-row grid. Layout:
 *   [left group]  sidebar-toggle + Breadcrumbs
 *   [right group] PanelSelectorDropdown + right-rail-toggle
 *
 * Background: var(--color-bg) with var(--shadow-elevation-1) drop shadow so
 * editor content slips visually behind it on scroll (D-05, D-31).
 *
 * Reads / writes existing store state only (no new store slices introduced here):
 *   - notesSidebarVisible / setNotesSidebarVisible (Phase 6.6 Plan 02 slice)
 *   - backlinksRailExpanded / setBacklinksRailExpanded (Phase 6 slice)
 *
 * Child components Breadcrumbs (Plan 07) and PanelSelectorDropdown (Plan 08)
 * handle their own store subscriptions; TopBar just mounts them.
 *
 * The optional `style` prop is spread over the root container so App.tsx can
 * pass grid-placement props directly:
 *   <TopBar style={{ gridRow: "1", gridColumn: "2" }} />
 */
import { useCallback, useState } from "react";
import type { CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { postAdminReindex } from "../lib/adminApi";
import { Breadcrumbs } from "./Breadcrumbs";
import { PanelSelectorDropdown } from "./PanelSelectorDropdown";
import { SaveIndicator } from "./SaveIndicator";

// ──────────────────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────────────────

// Plan 07-36 (UAT-3 N5, Approach A): horizontal padding tuned from 8px to
// 4px so the breadcrumb text-start aligns with --editor-content-x (30px) —
// 4px outer pad + 24px toggle button + 2px inner-group gap = 30px from the
// grid column edge, matching the editor's paddingLeft: var(--editor-content-x).
const topBarStyle: CSSProperties = {
  background: "var(--color-bg)",
  boxShadow: "var(--shadow-elevation-1)",
  zIndex: 10,
  height: 40,
  padding: "0 4px",
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

// ──────────────────────────────────────────────────────────────────────
// Internal ToggleButton helper
// ──────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────
// TopBar component
// ──────────────────────────────────────────────────────────────────────

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
  // Plan 07-37 (UAT-3 N9 / D-55): SaveIndicator-button reads the hoisted
  // saveState from the store (Plan 07-28 hoist STAYS — only the mounting
  // location moves from StatusBar to here).
  const saveState = useTreeStore((s) => s.saveState);
  // Plan 07-38 (UAT-4 N3): panel-selector state is now the authoritative
  // gate for the right-rail toggle (reverses Plan 07-30/07-35's
  // hasContent gate). The dropdown itself is ALWAYS visible — the user
  // needs a way to re-enable panels even when nothing is currently
  // selected. The toggle only appears when there's actually a rail to
  // show/hide (i.e. at least one panel selected).
  const panelSelectorState = useTreeStore((s) => s.panelSelector);
  const anyPanelSelected =
    panelSelectorState.tags || panelSelectorState.backlinks;

  const sidebarLabel = notesSidebarVisible
    ? "Hide notes sidebar"
    : "Show notes sidebar";
  const railLabel = backlinksRailExpanded ? "Hide panels" : "Show panels";

  // Plan 07-37: SaveIndicator-button click → manual incremental reindex (the
  // same call the prior StatusBar refresh button issued). The SaveIndicator
  // already DoS-guards by disabling itself while saveState.status === "saving"
  // (T-37-01); we still wrap the await in a try/catch so an unexpected reject
  // doesn't crash React's event loop.
  const handleRefresh = useCallback(async () => {
    try {
      await postAdminReindex("incremental");
    } catch (err) {
      console.warn("[TopBar] SaveIndicator-button refresh failed:", err);
    }
  }, []);

  return (
    <div
      style={{ ...topBarStyle, ...style }}
      data-testid="top-bar"
    >
      {/* Left group: sidebar toggle + breadcrumbs.
          Plan 07-36 (UAT-3 N5, Approach A): inner gap dropped from 4px to 2px
          so the toggle (24px) + gap (2px) lands the breadcrumb text-start at
          4px (outer pad) + 24px + 2px = 30px = --editor-content-x. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
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

      {/* Right group: SaveIndicator-button + PanelSelectorDropdown (always
          present) + right-rail toggle (gated on panelSelector state).

          Plan 07-38 (UAT-4 N3) supersedes Plan 07-30 / 07-35 / 07-37:
          - PanelSelectorDropdown is mounted UNCONDITIONALLY — the user
            needs a way to re-enable a panel even when none is currently
            selected (the previous hasContent gate hid the dropdown when
            there was no active-note content, leaving the user stuck).
          - The right-rail toggle is now gated on
            `useTreeStore.panelSelector.{tags,backlinks}` — i.e. is there
            actually a rail to show? An all-false panelSelector means the
            user has explicitly hidden every panel, so the toggle has
            nothing to toggle.
          - The SaveIndicator-button (Plan 07-37) is REMOVED from this
            location in Plan 07-38 (see Task 3 of Plan 07-38). It moves
            back to StatusBar per UAT-4 N9. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          flexShrink: 0,
        }}
      >
        <SaveIndicator state={saveState} onClick={handleRefresh} />
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
