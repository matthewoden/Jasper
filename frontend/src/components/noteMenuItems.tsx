/**
 * The note ⋯ menu's item list, lifted out of NoteOptionsMenu so the bookmarks
 * panel offers the same actions without a second copy of them.
 *
 * Parameterized by menu primitives because one body has to render under both a
 * DropdownMenu (kebab) and a ContextMenu (right-click); the item props stay
 * callbacks so the dialogs a row needs can be mounted once by the panel rather
 * than once per row.
 */
import {
  Bookmark,
  BookmarkCheck,
  FolderInput,
  FolderOpen,
  Locate,
  Pencil,
  Replace,
  Search,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";

import { revealInNavigation } from "../lib/revealInNavigation";
import {
  menuDestructiveItemStyle,
  menuItemStyle,
  menuSeparatorStyle,
  type MenuPrimitives,
} from "./noteMenu.utils";

export interface NoteMenuItemsProps {
  primitives: MenuPrimitives;
  noteId: string;
  bookmarked: boolean;
  onRequestRename: () => void;
  onMove: () => void;
  onSplit: (dir: "row" | "col") => void;
  onDelete: () => void;
  /** Omit to leave the bookmark toggle out entirely — bookmark rows render
   *  their own destructive "Remove bookmark" instead. */
  onToggleBookmark?: () => void;
  /** Rendered directly below the bookmark item (bookmark-specific extras). */
  bookmarkExtras?: ReactNode;
  onOpenFind?: () => void;
  onOpenFindReplace?: () => void;
  onRevealInFileManager?: () => void;
}

export function NoteMenuItems({
  primitives,
  noteId,
  bookmarked,
  onRequestRename,
  onMove,
  onSplit,
  onDelete,
  onToggleBookmark,
  bookmarkExtras,
  onOpenFind,
  onOpenFindReplace,
  onRevealInFileManager,
}: NoteMenuItemsProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Item = primitives.Item as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sep = primitives.Separator as any;

  return (
    <>
      <Item style={menuItemStyle} onSelect={() => onRequestRename()}>
        <Pencil size={15} aria-hidden="true" />
        <span>Rename</span>
      </Item>
      <Item style={menuItemStyle} onSelect={() => onMove()}>
        <FolderInput size={15} aria-hidden="true" />
        <span>Move to…</span>
      </Item>
      {onToggleBookmark && (
        <Item style={menuItemStyle} onSelect={() => onToggleBookmark()}>
          {bookmarked ? (
            <BookmarkCheck size={15} aria-hidden="true" />
          ) : (
            <Bookmark size={15} aria-hidden="true" />
          )}
          <span>{bookmarked ? "Remove bookmark" : "Bookmark"}</span>
        </Item>
      )}
      {bookmarkExtras}
      <Sep style={menuSeparatorStyle} />
      <Item style={menuItemStyle} onSelect={() => onSplit("row")}>
        <SplitSquareHorizontal size={15} aria-hidden="true" />
        <span>Split right</span>
      </Item>
      <Item style={menuItemStyle} onSelect={() => onSplit("col")}>
        <SplitSquareVertical size={15} aria-hidden="true" />
        <span>Split down</span>
      </Item>
      <Sep style={menuSeparatorStyle} />
      <Item style={menuItemStyle} onSelect={() => onOpenFind?.()}>
        <Search size={15} aria-hidden="true" />
        <span>Find</span>
      </Item>
      <Item style={menuItemStyle} onSelect={() => onOpenFindReplace?.()}>
        <Replace size={15} aria-hidden="true" />
        <span>Replace</span>
      </Item>
      <Sep style={menuSeparatorStyle} />
      <Item style={menuItemStyle} onSelect={() => revealInNavigation(noteId)}>
        <Locate size={15} aria-hidden="true" />
        <span>Reveal in navigation</span>
      </Item>
      <Item style={menuItemStyle} onSelect={() => onRevealInFileManager?.()}>
        <FolderOpen size={15} aria-hidden="true" />
        <span>Show in file manager</span>
      </Item>
      <Sep style={menuSeparatorStyle} />
      <Item style={menuDestructiveItemStyle} onSelect={() => onDelete()}>
        <Trash2 size={15} aria-hidden="true" />
        <span>Delete</span>
      </Item>
    </>
  );
}
