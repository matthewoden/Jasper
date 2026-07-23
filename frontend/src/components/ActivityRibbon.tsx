/**
 * ActivityRibbon — the 48px far-left activity bar. Top cluster (matching the
 * Vault.dc.html mock): vault badge, quick-switcher, daily-note, command
 * palette. Bottom (flex-pushed): a Settings gear that opens SettingsDialog.
 *
 * Phase 27 NAV-02 (D-09/D-10): the Files/Search toggles are gone — panel
 * selection now lives entirely in the sidebar's SidebarTabRow. The single
 * quick-switcher button here opens today's existing unmodified Cmd+O
 * switcher (mode="notes"); its restyle + create/split modifiers are
 * Phase 28 (QUICK-*), out of scope here.
 *
 * D-13 (Phase 31): the vault badge + its margin already consume more
 * vertical space than SidebarTabRow's 40px header, so the first RibbonButton
 * (Quick switcher) can't land pixel-perfect on that row's icon center without
 * relocating the badge (out of scope). Tightened top padding + badge margin
 * bring it closer; exact axis match is deferred to UI-review per this
 * plan's own verification note.
 */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { FileSearch, CalendarDays, Command, Settings } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { useDailyNote } from "../lib/useDailyNote";
import { useVaultPicker } from "../lib/useVaultPicker";
import { mod, shift } from "../lib/shortcutsRegistry";
import { SettingsDialog } from "./SettingsDialog";
import { Tooltip } from "./Tooltip";

const ribbonStyle: CSSProperties = {
  width: 48,
  height: "100%",
  background: "var(--color-surface-ribbon)",
  borderRight: "1px solid var(--color-border-inner)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
  padding: "8px 0",
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
  /** Tooltip label; defaults to ariaLabel when the two diverge in wording. */
  tooltipLabel?: string;
  /** Tooltip shortcut suffix, e.g. "⌘O" (D-08). Omit for no shortcut. */
  tooltipShortcut?: string;
  onClick: () => void;
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
}

function RibbonButton({
  ariaLabel,
  tooltipLabel,
  tooltipShortcut,
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
    <Tooltip label={tooltipLabel ?? ariaLabel} shortcut={tooltipShortcut} side="bottom">
      <button
        type="button"
        aria-label={ariaLabel}
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
    </Tooltip>
  );
}

interface ActivityRibbonProps {
  /** Optional style for grid placement; merged onto the outer nav. */
  style?: CSSProperties;
}

export function ActivityRibbon({
  style = {},
}: ActivityRibbonProps = {}): React.JSX.Element {
  const { openToday, isLoading: todayLoading } = useDailyNote();
  const { current } = useVaultPicker();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const displayName = current?.display_name ?? "";
  const trimmedDisplayName = displayName.trim();
  const badgeLetter =
    trimmedDisplayName.length > 0
      ? ([...trimmedDisplayName][0]?.toUpperCase() ?? "J")
      : "J";

  return (
    <nav style={{ ...ribbonStyle, ...style }} aria-label="Activity ribbon">
      <div
        role="img"
        aria-label={`Vault: ${displayName}`}
        style={{
          width: 30,
          height: 30,
          borderRadius: 6,
          marginBottom: 8,
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
        ariaLabel="Quick switcher"
        tooltipShortcut={`${mod}O`}
        onClick={() => {
          const s = useTreeStore.getState();
          s.setPaletteMode("notes");
          s.setPaletteOpen(true);
        }}
        icon={<FileSearch size={16} aria-hidden="true" />}
      />

      <RibbonButton
        ariaLabel="Open today's daily note"
        tooltipLabel="Today"
        tooltipShortcut={`${mod}${shift}D`}
        onClick={openToday}
        disabled={todayLoading}
        icon={<CalendarDays size={16} aria-hidden="true" />}
        style={{
          opacity: todayLoading ? 0.5 : 1,
          cursor: todayLoading ? "wait" : "pointer",
        }}
      />

      <RibbonButton
        ariaLabel="Open command palette"
        tooltipLabel="Command palette"
        tooltipShortcut={`${mod}P`}
        onClick={() => {
          const s = useTreeStore.getState();
          s.setPaletteMode("commands");
          s.setPaletteOpen(true);
        }}
        icon={<Command size={16} aria-hidden="true" />}
      />

      <div style={{ flex: 1 }} />

      <RibbonButton
        ariaLabel="Settings"
        onClick={() => setSettingsOpen(true)}
        icon={<Settings size={16} aria-hidden="true" />}
      />
      {/* Mount only when open so we don't double-fetch config alongside the
          StatusBar's own SettingsDialog instance. */}
      {settingsOpen && (
        <SettingsDialog open onOpenChange={setSettingsOpen} />
      )}
    </nav>
  );
}
