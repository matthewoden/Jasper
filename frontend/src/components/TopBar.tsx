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
import { useState } from "react";
import type { CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { useTagsForNote } from "../lib/useTagsForNote";
import { useBacklinks } from "../lib/useBacklinks";
import { Breadcrumbs } from "./Breadcrumbs";
import { PanelSelectorDropdown } from "./PanelSelectorDropdown";

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
  // C3 (UAT-2 N3): read active note ID for backlinks count
  const activeNoteId = useTreeStore((s) => s.activeNoteId);

  // C3 (UAT-2 N3 → corrected UAT-3 N3): right-rail toggle only shown when the
  // ACTIVE NOTE has content to display (per-note semantics, Plan 07-35).
  // useTagsForNote(activeNoteId) returns tags for the active note only — NOT
  // vault-wide (that was the Plan 07-30 bug: useTagBrowser returned all tags).
  // useBacklinks(activeNoteId) is already per-note (correct since Plan 06-11).
  const { tags } = useTagsForNote(activeNoteId);
  const { backlinks } = useBacklinks(activeNoteId);
  const hasContent = tags.length > 0 || (backlinks?.length ?? 0) > 0;

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

      {/* Right group: panel selector dropdown + right-rail toggle */}
      {/* C3 (UAT-2 N3): right-rail toggle hidden when no tags AND no backlinks */}
      {hasContent && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            flexShrink: 0,
          }}
        >
          <PanelSelectorDropdown />
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
        </div>
      )}
    </div>
  );
}
