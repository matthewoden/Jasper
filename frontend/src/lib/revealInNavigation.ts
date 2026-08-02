/**
 * revealInNavigation — the note-options menu's "Reveal in navigation"
 * action. Switches the left sidebar to the Notes panel, scrolls the
 * tree to the note's row (fileTree.utils.scrollToNoteRow expands any
 * collapsed ancestors along the way via react-arborist's own openParents),
 * and applies the pulse-highlight class already used by the breadcrumb's
 * folder/note "reveal" jump (EditorPane.handleBreadcrumbClick) — reusing
 * that mechanism rather than inventing a new one.
 *
 * The CSS class applied is `jasper-pulse-target` (theme.css) — this is the
 * class name, not the @keyframes name it references — do not confuse the
 * two, they are named differently on purpose.
 */
import { scrollToNoteRow } from "../components/fileTree.utils";
import { useTreeStore } from "./useTreeStore";

export function revealInNavigation(noteId: string): void {
  useTreeStore.getState().setSidebarPanel("notes");
  useTreeStore.getState().setNotesSidebarVisible(true);
  scrollToNoteRow(noteId);
  useTreeStore.getState().setPulseTarget({ kind: "note", target: noteId });
}
