/**
 * NotesSortMenu — Notes-panel sort trigger + six-option Radix DropdownMenu
 * (SORT-01, D-02/D-05). Mounted in SidebarToolbar beside New note/New folder.
 *
 * menuContainerStyle/itemStyle/shortcutStyle below are re-declared identically
 * from TreeRowMenu.tsx (not imported — those constants are module-private
 * there) per the 29-05 plan's interfaces note: reuse the visual language
 * verbatim rather than inventing new menu CSS.
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowDownAZ, Check } from "lucide-react";
import { useState, type CSSProperties } from "react";

import type { NotesSortOrder } from "../lib/useTreeStore";

export interface NotesSortMenuProps {
  value: NotesSortOrder;
  onSelect: (order: NotesSortOrder) => void;
  /**
   * Controlled open state — primarily for tests, which need to force the
   * Radix portal content to mount without simulating a real pointer click.
   * Omit for normal uncontrolled usage (the component manages its own
   * open/closed state internally).
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const menuContainerStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  paddingTop: 4,
  paddingBottom: 4,
  minWidth: 200,
  maxWidth: 320,
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
  zIndex: 50,
};

const itemStyle: CSSProperties = {
  height: 32,
  display: "flex",
  alignItems: "center",
  padding: "0 16px",
  gap: 8,
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-fg)",
  cursor: "pointer",
  outline: "none",
  userSelect: "none",
};

const shortcutStyle: CSSProperties = {
  marginLeft: "auto",
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-muted)",
};

const triggerButtonStyle: CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
};

/** D-02 (exact order + copy — flat six-row list, no section headers). */
const SORT_ITEMS: ReadonlyArray<{ order: NotesSortOrder; label: string }> = [
  { order: "name-asc", label: "Name (A → Z)" },
  { order: "name-desc", label: "Name (Z → A)" },
  { order: "modified-desc", label: "Modified (new → old)" },
  { order: "modified-asc", label: "Modified (old → new)" },
  { order: "created-desc", label: "Created (new → old)" },
  { order: "created-asc", label: "Created (old → new)" },
];

export function NotesSortMenu({
  value,
  onSelect,
  open: openProp,
  onOpenChange,
}: NotesSortMenuProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const handleOpenChange = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title="Sort notes"
          aria-label="Sort notes"
          style={{
            ...triggerButtonStyle,
            color: open ? "var(--color-accent)" : "var(--color-muted)",
          }}
        >
          <ArrowDownAZ size={16} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          style={menuContainerStyle}
          side="bottom"
          align="start"
          sideOffset={4}
        >
          {SORT_ITEMS.map((item) => (
            <DropdownMenu.Item
              key={item.order}
              style={itemStyle}
              onSelect={() => onSelect(item.order)}
            >
              <span>{item.label}</span>
              {value === item.order && (
                <Check
                  size={14}
                  aria-hidden="true"
                  style={{ ...shortcutStyle, color: "var(--color-accent)" }}
                />
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
