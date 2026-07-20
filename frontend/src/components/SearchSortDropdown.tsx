/**
 * SearchSortDropdown — three-option sort control for the sidebar Search
 * panel (SORT-02, D-15). Mounted beside the search input in
 * SidebarSearchPanel.tsx.
 *
 * Unlike NotesSortMenu's icon-only trigger, this trigger renders the
 * current selection as text ("Relevance ▾" etc.) at 12px muted — the
 * search panel already has a text status line at this size, so an
 * icon-only control here would look orphaned (UI-SPEC Component
 * Inventory, SearchSortDropdown row).
 *
 * Style constants are re-declared here (not imported from TreeRowMenu.tsx)
 * to avoid a merge collision with the concurrently-running 29-05 plan,
 * which also touches menu chrome. Values are copied verbatim from
 * TreeRowMenu.tsx's menuContainerStyle/itemStyle/shortcutStyle so both
 * sort surfaces read as one consistent visual language.
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import type { CSSProperties } from "react";
import type { SearchSortOrder } from "../lib/useTreeStore";

export interface SearchSortDropdownProps {
  value: SearchSortOrder;
  onSelect: (value: SearchSortOrder) => void;
  /** Controlled open state — used by tests to bypass jsdom pointer-event quirks. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const OPTIONS: Array<{ value: SearchSortOrder; label: string; triggerLabel: string }> = [
  { value: "relevance", label: "Relevance", triggerLabel: "Relevance" },
  { value: "modified", label: "Modified (new → old)", triggerLabel: "Modified" },
  { value: "created", label: "Created (new → old)", triggerLabel: "Created" },
];

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

const triggerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  background: "transparent",
  border: "none",
  padding: 0,
  fontSize: 12,
  color: "var(--color-muted)",
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

export function SearchSortDropdown({
  value,
  onSelect,
  open,
  onOpenChange,
}: SearchSortDropdownProps) {
  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button type="button" style={triggerStyle} aria-label="Sort search results">
          <span>{current.triggerLabel} ▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content style={menuContainerStyle} side="bottom" align="start" sideOffset={4}>
          {OPTIONS.map((option) => (
            <DropdownMenu.Item
              key={option.value}
              style={itemStyle}
              onSelect={() => onSelect(option.value)}
            >
              <span>{option.label}</span>
              {option.value === value && (
                <Check
                  size={14}
                  aria-hidden="true"
                  style={{ ...shortcutStyle, marginLeft: "auto", color: "var(--color-accent)" }}
                />
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
