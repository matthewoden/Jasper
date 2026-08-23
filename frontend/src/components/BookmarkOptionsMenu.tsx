/**
 * The bookmark row's ⋯ menu. Item set is NoteOptionsMenu's (shared verbatim via
 * NoteMenuItems) plus the two bookmark-specific entries, so a bookmarked note
 * can be managed without first finding it in the notes tree.
 *
 * Purely presentational: every action is a callback, and the dialogs they open
 * are mounted once by BookmarksPanel rather than once per row.
 */
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bookmark, FolderTree, MoreHorizontal } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { NoteMenuItems } from "./noteMenuItems";
import {
  contextPrimitives,
  dropdownPrimitives,
  menuContainerStyle,
  menuDestructiveItemStyle,
  menuItemStyle,
  menuSeparatorStyle,
  menuTriggerStyle,
  type MenuPrimitives,
} from "./noteMenu.utils";
import { Tooltip } from "./Tooltip";

export interface BookmarkMenuActions {
  noteId: string;
  folders: ReadonlyArray<{ id: string; name: string }>;
  onRequestRename: () => void;
  onMove: () => void;
  onSplit: (dir: "row" | "col") => void;
  onDelete: () => void;
  onRemoveBookmark: () => void;
  onMoveToBookmarkFolder: (folderId: string | null) => void;
  onNewBookmarkFolder: () => void;
  onOpenFind: () => void;
  onOpenFindReplace: () => void;
  onRevealInFileManager: () => void;
}

function BookmarkMenuBody({
  primitives,
  noteId,
  folders,
  onRequestRename,
  onMove,
  onSplit,
  onDelete,
  onRemoveBookmark,
  onMoveToBookmarkFolder,
  onNewBookmarkFolder,
  onOpenFind,
  onOpenFindReplace,
  onRevealInFileManager,
}: BookmarkMenuActions & { primitives: MenuPrimitives }) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const Item = primitives.Item as any;
  const Sep = primitives.Separator as any;
  const Sub = primitives.Sub as any;
  const SubTrigger = primitives.SubTrigger as any;
  const SubContent = primitives.SubContent as any;
  const Portal = primitives.Portal as any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const extras = (
    <>
      <Item style={menuDestructiveItemStyle} onSelect={() => onRemoveBookmark()}>
        <Bookmark size={15} aria-hidden="true" />
        <span>Remove bookmark</span>
      </Item>
      <Sub>
        <SubTrigger style={menuItemStyle}>
          <FolderTree size={15} aria-hidden="true" />
          <span>Move to bookmark folder</span>
        </SubTrigger>
        <Portal>
          <SubContent style={menuContainerStyle}>
            <Item style={menuItemStyle} onSelect={() => onMoveToBookmarkFolder(null)}>
              <span>(No folder)</span>
            </Item>
            {folders.length > 0 && <Sep style={menuSeparatorStyle} />}
            {folders.map((f) => (
              <Item
                key={f.id}
                style={menuItemStyle}
                onSelect={() => onMoveToBookmarkFolder(f.id)}
              >
                <span>{f.name}</span>
              </Item>
            ))}
            <Sep style={menuSeparatorStyle} />
            <Item style={menuItemStyle} onSelect={() => onNewBookmarkFolder()}>
              <span>New folder…</span>
            </Item>
          </SubContent>
        </Portal>
      </Sub>
    </>
  );

  return (
    <NoteMenuItems
      primitives={primitives}
      noteId={noteId}
      bookmarked
      onRequestRename={onRequestRename}
      onMove={onMove}
      onSplit={onSplit}
      onDelete={onDelete}
      bookmarkExtras={extras}
      onOpenFind={onOpenFind}
      onOpenFindReplace={onOpenFindReplace}
      onRevealInFileManager={onRevealInFileManager}
    />
  );
}

export interface BookmarkOptionsMenuProps extends BookmarkMenuActions {
  /** Controlled open state — tests force the portal to mount without a real
   *  pointer click. Mirrors NoteOptionsMenu/NotesSortMenu. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function BookmarkOptionsMenu({
  open: openProp,
  onOpenChange,
  ...actions
}: BookmarkOptionsMenuProps) {
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
            aria-label="Bookmark options"
            data-bookmark-row-kebab
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
          <BookmarkMenuBody primitives={dropdownPrimitives} {...actions} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function BookmarkRowContextMenu({
  children,
  ...actions
}: BookmarkMenuActions & { children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content style={menuContainerStyle}>
          <BookmarkMenuBody primitives={contextPrimitives} {...actions} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
