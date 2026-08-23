/**
 * Style constants and menu-primitive bundles for the note ⋯ menu, split out of
 * noteMenuItems.tsx so that file exports only components (Fast Refresh).
 */
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { CSSProperties } from "react";

export const menuTriggerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: 6,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--color-muted)",
};

export const menuContainerStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  width: 210,
  paddingTop: 4,
  paddingBottom: 4,
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
  zIndex: 50,
};

export const menuItemStyle: CSSProperties = {
  height: 32,
  display: "flex",
  alignItems: "center",
  padding: "0 8px",
  gap: 8,
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-fg)",
  cursor: "pointer",
  outline: "none",
  userSelect: "none",
};

export const menuDestructiveItemStyle: CSSProperties = {
  ...menuItemStyle,
  color: "var(--color-destructive)",
};

export const menuSeparatorStyle: CSSProperties = {
  height: 1,
  background: "var(--color-border)",
  margin: "4px 0",
  border: "none",
};

export interface MenuPrimitives {
  Item: typeof DropdownMenu.Item | typeof ContextMenu.Item;
  Separator: typeof DropdownMenu.Separator | typeof ContextMenu.Separator;
  Sub: typeof DropdownMenu.Sub | typeof ContextMenu.Sub;
  SubTrigger: typeof DropdownMenu.SubTrigger | typeof ContextMenu.SubTrigger;
  SubContent: typeof DropdownMenu.SubContent | typeof ContextMenu.SubContent;
  Portal: typeof DropdownMenu.Portal | typeof ContextMenu.Portal;
}

export const dropdownPrimitives: MenuPrimitives = {
  Item: DropdownMenu.Item,
  Separator: DropdownMenu.Separator,
  Sub: DropdownMenu.Sub,
  SubTrigger: DropdownMenu.SubTrigger,
  SubContent: DropdownMenu.SubContent,
  Portal: DropdownMenu.Portal,
};

export const contextPrimitives: MenuPrimitives = {
  Item: ContextMenu.Item,
  Separator: ContextMenu.Separator,
  Sub: ContextMenu.Sub,
  SubTrigger: ContextMenu.SubTrigger,
  SubContent: ContextMenu.SubContent,
  Portal: ContextMenu.Portal,
};

