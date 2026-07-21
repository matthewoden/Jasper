/**
 * useNoteTagsStore — dedicated Zustand store for the live tag list feeding
 * the Tags tab's upper section (TAGS-02). Mirrors useOutlineStore's shape.
 *
 * Written by the ACTIVE editor's MarkdownEditor instance only (EditorPane
 * gates writes on noteId === activeNoteId), read by NoteTagsSection (Plan 09).
 */
import { create } from "zustand";

export interface NoteTagsStore {
  noteTags: string[];
  setNoteTags: (tags: string[]) => void;
}

export const useNoteTagsStore = create<NoteTagsStore>((set) => ({
  noteTags: [],
  setNoteTags: (tags) => set({ noteTags: tags }),
}));
