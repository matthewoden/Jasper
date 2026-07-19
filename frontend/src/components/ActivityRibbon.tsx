/**
 * ActivityRibbon — the 48px far-left activity bar: vault badge, Files/Search
 * toggles, daily-note button, and the command-palette button.
 *
 * Files/Search toggles implement the symmetric open/switch-in-place/collapse
 * model (D-01/D-02/D-03): each button opens the sidebar to its panel; the
 * active one collapses on repeat click; clicking the other switches panels
 * in place. Accent active-state is derived from `sidebarPanel` + sidebar
 * visibility (D-07), replacing the old palette-mode-derived check — see
 * 19-04 (LSIDE-02).
 */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Folder, Search, CalendarDays, Command } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { useDailyNote } from "../lib/useDailyNote";
import { useVaultPicker } from "../lib/useVaultPicker";
import { mod, shift } from "../lib/shortcutsRegistry";
import { dispatchPhase7 } from "../lib/appShortcuts";

const ribbonStyle: CSSProperties = {
  width: 48,
  height: "100%",
  background: "var(--color-surface-ribbon)",
  borderRight: "1px solid var(--color-border-inner)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
};

const buttonBase: CSSProperties = {
  width: 32,
  height: 32,
  padding: 4,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
};

interface RibbonButtonProps {
  ariaLabel: string;
  title?: string;
  onClick: () => void;
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
}

function RibbonButton({
  ariaLabel,
  title,
  onClick,
  icon,
  active = false,
  disabled = false,
  style,
}: RibbonButtonProps): React.JSX.Element {
  const [hovering, setHovering] = useState(false);
  // Disabled buttons suppress mouse events: if the pointer leaves while
  // disabled, onMouseLeave never fires and the tint would reappear on
  // re-enable — reset instead of trusting the leave event.
  useEffect(() => {
    if (disabled) setHovering(false);
  }, [disabled]);
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        ...buttonBase,
        color: active ? "var(--color-accent)" : "var(--color-muted)",
        background:
          !disabled && hovering
            ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
            : "transparent",
        ...style,
      }}
    >
      {icon}
    </button>
  );
}

interface ActivityRibbonProps {
  /** Optional style for grid placement; merged onto the outer nav. */
  style?: CSSProperties;
}

export function ActivityRibbon({
  style = {},
}: ActivityRibbonProps = {}): React.JSX.Element {
  const notesSidebarVisible = useTreeStore((s) => s.notesSidebarVisible);
  const setNotesSidebarVisible = useTreeStore((s) => s.setNotesSidebarVisible);
  const sidebarPanel = useTreeStore((s) => s.sidebarPanel);
  const setSidebarPanel = useTreeStore((s) => s.setSidebarPanel);

  const { openToday, isLoading: todayLoading } = useDailyNote();
  const { current } = useVaultPicker();

  const displayName = current?.display_name ?? "";
  const trimmedDisplayName = displayName.trim();
  const badgeLetter =
    trimmedDisplayName.length > 0
      ? ([...trimmedDisplayName][0]?.toUpperCase() ?? "J")
      : "J";

  const searchActive = notesSidebarVisible && sidebarPanel === "search";
  const filesActive = notesSidebarVisible && sidebarPanel === "notes";

  return (
    <nav style={{ ...ribbonStyle, ...style }} aria-label="Activity ribbon">
      <div
        role="img"
        aria-label={`Vault: ${displayName}`}
        style={{
          width: 30,
          height: 30,
          borderRadius: 6,
          marginTop: 8,
          background:
            "color-mix(in srgb, var(--color-accent) 16%, var(--color-surface-ribbon))",
          color: "var(--color-accent)",
          fontSize: 14,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {badgeLetter}
      </div>

      <RibbonButton
        ariaLabel="Files"
        active={filesActive}
        onClick={() => {
          if (filesActive) {
            setNotesSidebarVisible(false);
          } else {
            setSidebarPanel("notes");
            setNotesSidebarVisible(true);
          }
        }}
        icon={<Folder size={16} aria-hidden="true" />}
        style={{ marginTop: 8 }}
      />

      <RibbonButton
        ariaLabel="Search notes"
        title={`Search notes (${mod}${shift}F)`}
        active={searchActive}
        onClick={() => {
          if (searchActive) {
            setNotesSidebarVisible(false);
          } else {
            setSidebarPanel("search");
            setNotesSidebarVisible(true);
            // Switching from Files (or opening from closed) mounts
            // SidebarSearchPanel for the first time in this same tick;
            // its subscribePhase7 effect only registers after React commits
            // and runs passive effects, which happens AFTER this handler
            // returns. Dispatching synchronously here would fire into an
            // empty subscriber set and silently drop the focus request.
            // Defer one frame so the panel has mounted and subscribed.
            requestAnimationFrame(() => dispatchPhase7("focusSearch"));
          }
        }}
        icon={<Search size={16} aria-hidden="true" />}
        style={{ marginTop: 4 }}
      />

      <RibbonButton
        ariaLabel="Open today's daily note"
        title={`Today (${mod}${shift}D)`}
        onClick={openToday}
        disabled={todayLoading}
        icon={<CalendarDays size={16} aria-hidden="true" />}
        style={{
          marginTop: 16,
          opacity: todayLoading ? 0.5 : 1,
          cursor: todayLoading ? "wait" : "pointer",
        }}
      />

      <div style={{ flex: 1 }} />

      <RibbonButton
        ariaLabel="Open command palette"
        title={`Command palette (${mod}P)`}
        onClick={() => {
          const s = useTreeStore.getState();
          s.setPaletteMode("commands");
          s.setPaletteOpen(true);
        }}
        icon={<Command size={16} aria-hidden="true" />}
        style={{ marginBottom: 8 }}
      />
    </nav>
  );
}
