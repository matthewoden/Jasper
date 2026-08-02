/**
 * TabContextMenu — Radix ContextMenu wrapping a tab pill trigger.
 *
 * 9 items in the locked order (CTX-01 — an Obsidian-literal mapping onto
 * Jasper's item set), with separators after items 4, 6, and 7:
 *   1. Close
 *   2. Close others
 *   3. Close to the right
 *   4. Close all
 *   ── sep ──
 *   5. Open in split
 *   6. New note to the right
 *   ── sep ──
 *   7. Pin tab (Unpin tab, if already pinned)
 *   ── sep ──
 *   8. Rename
 *   9. Show in file manager
 *
 * Styling tokens mirror TreeRowMenu; item font size is 12px — reused
 * verbatim for every new item, do not resize.
 */
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { CSSProperties, ReactNode } from "react";

export interface TabContextMenuProps {
  children: ReactNode;
  onOpenRight: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseToRight: () => void;
  onCloseAll: () => void;
  onOpenSplit: () => void;
  isPinned: boolean;
  onTogglePin: () => void;
  onRename: () => void;
  onReveal: () => void;
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
  fontSize: 12,
  fontWeight: 400,
  color: "var(--color-fg)",
  cursor: "pointer",
  outline: "none",
  userSelect: "none",
};

const separatorStyle: CSSProperties = {
  height: 1,
  background: "var(--color-border)",
  margin: "4px 0",
  border: "none",
};

export function TabContextMenu({
  children,
  onOpenRight,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onOpenSplit,
  isPinned,
  onTogglePin,
  onRename,
  onReveal,
}: TabContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content style={menuContainerStyle}>
          <ContextMenu.Item style={itemStyle} onSelect={() => onClose()}>
            <span>Close</span>
          </ContextMenu.Item>
          <ContextMenu.Item style={itemStyle} onSelect={() => onCloseOthers()}>
            <span>Close others</span>
          </ContextMenu.Item>
          <ContextMenu.Item style={itemStyle} onSelect={() => onCloseToRight()}>
            <span>Close to the right</span>
          </ContextMenu.Item>
          <ContextMenu.Item style={itemStyle} onSelect={() => onCloseAll()}>
            <span>Close all</span>
          </ContextMenu.Item>
          <ContextMenu.Separator style={separatorStyle} />
          <ContextMenu.Item style={itemStyle} onSelect={() => onOpenSplit()}>
            <span>Open in split</span>
          </ContextMenu.Item>
          <ContextMenu.Item style={itemStyle} onSelect={() => onOpenRight()}>
            <span>New note to the right</span>
          </ContextMenu.Item>
          <ContextMenu.Separator style={separatorStyle} />
          <ContextMenu.Item style={itemStyle} onSelect={() => onTogglePin()}>
            <span>{isPinned ? "Unpin tab" : "Pin tab"}</span>
          </ContextMenu.Item>
          <ContextMenu.Separator style={separatorStyle} />
          <ContextMenu.Item style={itemStyle} onSelect={() => onRename()}>
            <span>Rename</span>
          </ContextMenu.Item>
          <ContextMenu.Item style={itemStyle} onSelect={() => onReveal()}>
            <span>Show in file manager</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
