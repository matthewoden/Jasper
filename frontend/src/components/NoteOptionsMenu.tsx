/**
 * NoteOptionsMenu — the per-pane 3-dot menu (CTX-03). DropdownMenu only; it has
 * no right-click trigger, so it copies only TreeRowMenu's dropdown half.
 *
 * Deliberately does NOT import TreeRowMenu's styles: this menu has its own
 * floating-card radius, and mixing radii within one visual family reads as a bug
 * rather than a choice. The item list itself lives in noteMenuItems.tsx, shared
 * with the bookmarks panel's row menu.
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { useCallback, useState } from "react";

import { basename } from "./fileTree.utils";
import { useBookmarks } from "../lib/useBookmarks";
import { usePaneStore } from "../lib/usePaneStore";
import { useReveal } from "../lib/useReveal";
import { useTreeMutations } from "../lib/useTreeMutations";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { MoveToFolderModal } from "./MoveToFolderModal";
import { NoteMenuItems } from "./noteMenuItems";
import {
  dropdownPrimitives,
  menuContainerStyle,
  menuTriggerStyle,
} from "./noteMenu.utils";
import { Tooltip } from "./Tooltip";
import { useToast } from "./toast.utils";

export interface NoteOptionsMenuProps {
  noteId: string;
  notePath: string;
  onOpenFind?: () => void;
  onOpenFindReplace?: () => void;
  /** Focuses (and selects) the inline title element — the existing rename
   *  affordance (H1-is-the-filename binding); there is no separate rename
   *  modal/dialog. */
  onRequestRename: () => void;
  /**
   * Controlled open state — primarily for tests, which need to force the
   * Radix portal content to mount without simulating a real pointer click.
   * Omit for normal uncontrolled usage (the component manages its own
   * open/closed state internally). Mirrors NotesSortMenu.tsx's pattern.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function NoteOptionsMenu({
  noteId,
  notePath,
  onOpenFind,
  onOpenFindReplace,
  onRequestRename,
  open: openProp,
  onOpenChange,
}: NoteOptionsMenuProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { isBookmarked, toggleBookmark } = useBookmarks();
  const { reveal } = useReveal();
  const { deleteNote } = useTreeMutations();
  const { toast } = useToast();

  const bookmarked = isBookmarked(noteId);

  const handleSplit = useCallback((dir: "row" | "col") => {
    usePaneStore.getState().splitActivePane(dir);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    try {
      await deleteNote(noteId);
    } catch {
      toast({ title: "Couldn't delete note. Try again.", variant: "error" });
    } finally {
      setDeleteOpen(false);
    }
  }, [deleteNote, noteId, toast]);

  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={handleOpenChange}>
        <Tooltip label="More options" side="bottom">
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Note options"
              style={menuTriggerStyle}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            style={menuContainerStyle}
            side="bottom"
            align="end"
            sideOffset={4}
          >
            <NoteMenuItems
              primitives={dropdownPrimitives}
              noteId={noteId}
              bookmarked={bookmarked}
              onRequestRename={onRequestRename}
              onMove={() => setMoveOpen(true)}
              onSplit={handleSplit}
              onDelete={() => setDeleteOpen(true)}
              onToggleBookmark={() => {
                void toggleBookmark(noteId);
              }}
              onOpenFind={onOpenFind}
              onOpenFindReplace={onOpenFindReplace}
              onRevealInFileManager={() => {
                void reveal(notePath);
              }}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <MoveToFolderModal
        noteId={noteId}
        notePath={notePath}
        open={moveOpen}
        onOpenChange={setMoveOpen}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        target={{ kind: "note", name: basename(notePath), id: noteId }}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}
