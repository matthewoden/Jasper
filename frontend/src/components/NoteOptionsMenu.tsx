/**
 * NoteOptionsMenu — per-pane 3-dot note-options menu (CTX-03, D-21..D-25).
 *
 * DropdownMenu-only (click-triggered, never right-click) — structurally
 * copies TreeRowMenu.tsx's TreeRowDropdownMenu HALF, not the dual-primitive
 * ContextMenu/DropdownMenu pattern (this menu has no right-click trigger).
 * Deliberately does NOT import styles from TreeRowMenu — UI-SPEC §5 gives
 * this menu its own "floating card" formula (10px radius / 210px width),
 * distinct from TreeRowMenu/TabContextMenu's 6px shared convention — mixing
 * radii within one visual family would look like a bug, not a choice.
 *
 * Mounted at the right edge of EditorPane's breadcrumb header row, beside
 * the bookmark star. Split right/down call usePaneStore.getState()
 * .splitActivePane() directly (no explicit "activate this pane" step): the
 * trigger button's click already bubbles through LeafPane's
 * onClickCapture={activate} handler (capture phase, fires before this
 * component's own onClick) before the menu even opens, so by the time a
 * split item is picked this pane is already usePaneStore's activePaneId.
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Bookmark,
  BookmarkCheck,
  FolderInput,
  FolderOpen,
  Locate,
  MoreHorizontal,
  Pencil,
  Replace,
  Search,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Trash2,
} from "lucide-react";
import { useCallback, useState, type CSSProperties } from "react";

import { basename } from "./fileTree.utils";
import { useBookmarks } from "../lib/useBookmarks";
import { usePaneStore } from "../lib/usePaneStore";
import { useReveal } from "../lib/useReveal";
import { revealInNavigation } from "../lib/revealInNavigation";
import { useTreeMutations } from "../lib/useTreeMutations";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { MoveToFolderModal } from "./MoveToFolderModal";
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

const triggerStyle: CSSProperties = {
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

const menuContainerStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  width: 210,
  paddingTop: 4,
  paddingBottom: 4,
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
  zIndex: 50,
};

const itemStyle: CSSProperties = {
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

const destructiveItemStyle: CSSProperties = {
  ...itemStyle,
  color: "var(--color-destructive)",
};

const separatorStyle: CSSProperties = {
  height: 1,
  background: "var(--color-border)",
  margin: "4px 0",
  border: "none",
};

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
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Note options"
            title="More options"
            style={triggerStyle}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            style={menuContainerStyle}
            side="bottom"
            align="end"
            sideOffset={4}
          >
            <DropdownMenu.Item style={itemStyle} onSelect={() => onRequestRename()}>
              <Pencil size={15} aria-hidden="true" />
              <span>Rename</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item style={itemStyle} onSelect={() => setMoveOpen(true)}>
              <FolderInput size={15} aria-hidden="true" />
              <span>Move to…</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              style={itemStyle}
              onSelect={() => {
                void toggleBookmark(noteId);
              }}
            >
              {bookmarked ? (
                <BookmarkCheck size={15} aria-hidden="true" />
              ) : (
                <Bookmark size={15} aria-hidden="true" />
              )}
              <span>{bookmarked ? "Remove bookmark" : "Bookmark"}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator style={separatorStyle} />
            <DropdownMenu.Item style={itemStyle} onSelect={() => handleSplit("row")}>
              <SplitSquareHorizontal size={15} aria-hidden="true" />
              <span>Split right</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item style={itemStyle} onSelect={() => handleSplit("col")}>
              <SplitSquareVertical size={15} aria-hidden="true" />
              <span>Split down</span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator style={separatorStyle} />
            <DropdownMenu.Item style={itemStyle} onSelect={() => onOpenFind?.()}>
              <Search size={15} aria-hidden="true" />
              <span>Find</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item style={itemStyle} onSelect={() => onOpenFindReplace?.()}>
              <Replace size={15} aria-hidden="true" />
              <span>Replace</span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator style={separatorStyle} />
            <DropdownMenu.Item style={itemStyle} onSelect={() => revealInNavigation(noteId)}>
              <Locate size={15} aria-hidden="true" />
              <span>Reveal in navigation</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              style={itemStyle}
              onSelect={() => {
                void reveal(notePath);
              }}
            >
              <FolderOpen size={15} aria-hidden="true" />
              <span>Show in file manager</span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator style={separatorStyle} />
            <DropdownMenu.Item
              style={destructiveItemStyle}
              onSelect={() => setDeleteOpen(true)}
            >
              <Trash2 size={15} aria-hidden="true" />
              <span>Delete</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <MoveToFolderModal noteId={noteId} open={moveOpen} onOpenChange={setMoveOpen} />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        target={{ kind: "note", name: basename(notePath), id: noteId }}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}
