/**
 * TabContextMenu — Radix ContextMenu wrapping a tab pill trigger.
 *
 * Four items in fixed spec order (TAB-06), with a separator after item 1:
 *   1. New note to the right   (separator)
 *   2. Close tab
 *   3. Close other tabs
 *   4. Close tabs to the right
 *
 * Styling tokens mirror TreeRowMenu; item font size is 12px per UI-SPEC.
 */
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { CSSProperties, ReactNode } from "react";

export interface TabContextMenuProps {
  children: ReactNode;
  onOpenRight: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseToRight: () => void;
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
}: TabContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content style={menuContainerStyle}>
          <ContextMenu.Item style={itemStyle} onSelect={() => onOpenRight()}>
            <span>New note to the right</span>
          </ContextMenu.Item>
          <ContextMenu.Separator style={separatorStyle} />
          <ContextMenu.Item style={itemStyle} onSelect={() => onClose()}>
            <span>Close tab</span>
          </ContextMenu.Item>
          <ContextMenu.Item style={itemStyle} onSelect={() => onCloseOthers()}>
            <span>Close other tabs</span>
          </ContextMenu.Item>
          <ContextMenu.Item style={itemStyle} onSelect={() => onCloseToRight()}>
            <span>Close tabs to the right</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
