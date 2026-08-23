/**
 * The bookmark-folder row's ⋯ menu. Only two actions exist because a bookmark
 * folder is a grouping label, not a container: there is nothing to create
 * inside it and nothing filesystem-shaped to reveal.
 */
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import {
  contextPrimitives,
  dropdownPrimitives,
  menuContainerStyle,
  menuDestructiveItemStyle,
  menuItemStyle,
  menuTriggerStyle,
  type MenuPrimitives,
} from "./noteMenu.utils";
import { Tooltip } from "./Tooltip";

export interface BookmarkFolderMenuActions {
  onRename: () => void;
  onDelete: () => void;
}

function FolderMenuBody({
  primitives,
  onRename,
  onDelete,
}: BookmarkFolderMenuActions & { primitives: MenuPrimitives }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Item = primitives.Item as any;
  return (
    <>
      <Item style={menuItemStyle} onSelect={() => onRename()}>
        <Pencil size={15} aria-hidden="true" />
        <span>Rename folder</span>
      </Item>
      <Item style={menuDestructiveItemStyle} onSelect={() => onDelete()}>
        <Trash2 size={15} aria-hidden="true" />
        <span>Delete folder</span>
      </Item>
    </>
  );
}

export interface BookmarkFolderOptionsMenuProps extends BookmarkFolderMenuActions {
  /** Controlled open state — tests force the portal to mount without a real
   *  pointer click. Mirrors NoteOptionsMenu/NotesSortMenu. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function BookmarkFolderOptionsMenu({
  open: openProp,
  onOpenChange,
  ...actions
}: BookmarkFolderOptionsMenuProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  return (
    <DropdownMenu.Root open={open} onOpenChange={handleOpenChange}>
      <Tooltip label="More options" side="bottom">
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Bookmark folder options"
            data-bookmark-folder-kebab
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={menuTriggerStyle}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          style={menuContainerStyle}
          side="right"
          align="start"
          sideOffset={4}
        >
          <FolderMenuBody primitives={dropdownPrimitives} {...actions} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function BookmarkFolderContextMenu({
  children,
  ...actions
}: BookmarkFolderMenuActions & { children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content style={menuContainerStyle}>
          <FolderMenuBody primitives={contextPrimitives} {...actions} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
