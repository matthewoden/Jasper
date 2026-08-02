/**
 * Reuses the pulse-highlight already driven by the breadcrumb's reveal jump
 * (EditorPane.handleBreadcrumbClick) rather than inventing a second mechanism.
 *
 * The class applied is `jasper-pulse-target` — that is the class name, not the
 * @keyframes name it references. They are named differently on purpose.
 */
import { scrollToNoteRow } from "../components/fileTree.utils";
import { useTreeStore } from "./useTreeStore";

export function revealInNavigation(noteId: string): void {
  useTreeStore.getState().setSidebarPanel("notes");
  useTreeStore.getState().setNotesSidebarVisible(true);
  scrollToNoteRow(noteId);
  useTreeStore.getState().setPulseTarget({ kind: "note", target: noteId });
}
