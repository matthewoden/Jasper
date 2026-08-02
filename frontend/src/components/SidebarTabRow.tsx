/**
 * SidebarTabRow — the Notes / Search / Bookmarks tabs plus the collapse control,
 * inside the Sidebar's 40px header (NAV-01/NAV-03).
 *
 * A tab click must ALSO reopen the sidebar: the collapse control lives in this
 * same row, so a click while collapsed can never be a no-op.
 */
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { FolderClosed, Search, Bookmark, PanelLeft } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { dispatchAppShortcut } from "../lib/appShortcuts";
import { Tooltip } from "./Tooltip";

type SidebarPanel = "notes" | "search" | "bookmarks";

const tabBase: CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  border: "none",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 6,
};

interface TabButtonProps {
  ariaLabel: string;
  title: string;
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
}

function TabButton({
  ariaLabel,
  title,
  active,
  onClick,
  icon,
}: TabButtonProps): React.JSX.Element {
  const [hovering, setHovering] = useState(false);
  return (
    <Tooltip label={title} side="bottom">
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onClick}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={{
          ...tabBase,
          color: active ? "var(--color-accent)" : "var(--color-muted)",
          background: active
            ? "color-mix(in srgb, var(--color-accent) 14%, transparent)"
            : hovering
              ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
              : "transparent",
        }}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

const collapseButtonBase: CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 6,
};

export function SidebarTabRow(): React.JSX.Element {
  const sidebarPanel = useTreeStore((s) => s.sidebarPanel);
  const setSidebarPanel = useTreeStore((s) => s.setSidebarPanel);
  const setNotesSidebarVisible = useTreeStore((s) => s.setNotesSidebarVisible);
  const [collapseHovering, setCollapseHovering] = useState(false);

  const selectPanel = (panel: SidebarPanel) => {
    setSidebarPanel(panel);
    setNotesSidebarVisible(true);
    // Opening the Search tab must focus the query input. rAF defers past
    // React's commit so SidebarSearchPanel's
    // focusSearch subscriber exists (same reasoning as handleAppCmdShiftF).
    if (panel === "search") {
      requestAnimationFrame(() => dispatchAppShortcut("focusSearch"));
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
      }}
      data-testid="sidebar-tab-row"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <TabButton
          ariaLabel="Notes"
          title="Notes"
          active={sidebarPanel === "notes"}
          onClick={() => selectPanel("notes")}
          icon={<FolderClosed size={16} aria-hidden="true" />}
        />
        <TabButton
          ariaLabel="Search"
          title="Search"
          active={sidebarPanel === "search"}
          onClick={() => selectPanel("search")}
          icon={<Search size={16} aria-hidden="true" />}
        />
        <TabButton
          ariaLabel="Bookmarks"
          title="Bookmarks"
          active={sidebarPanel === "bookmarks"}
          onClick={() => selectPanel("bookmarks")}
          icon={<Bookmark size={16} aria-hidden="true" />}
        />
      </div>
      <Tooltip label="Collapse sidebar" side="bottom">
        <button
          type="button"
          aria-label="Collapse sidebar"
          onClick={() => setNotesSidebarVisible(false)}
          onMouseEnter={() => setCollapseHovering(true)}
          onMouseLeave={() => setCollapseHovering(false)}
          style={{
            ...collapseButtonBase,
            // Optical alignment: center this 30px control on the 24px
            // collapse-all-folders toolbar button below it (center x 287).
            marginRight: -11,
            background: collapseHovering
              ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
              : "transparent",
          }}
        >
          <PanelLeft size={16} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}
