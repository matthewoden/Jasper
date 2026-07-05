/**
 * useOutlineStore — dedicated Zustand store for the Outline panel (RSIDE-01).
 *
 * Deliberately NOT a useTreeStore slice: decouples the right-sidebar Outline
 * panel from useTreeStore churn (tree/tab/search state changes shouldn't
 * force this store's subscribers to re-render, and vice versa).
 *
 * Written by the ACTIVE editor's MarkdownEditor instance only (EditorPane
 * gates writes on noteId === activeNoteId), read by OutlinePanel. Holds:
 *   - outlineHeadings: the live heading list for whichever note is active
 *   - scrollToHeading: a callback bound to the active editor's CM6 view,
 *     re-registered whenever the active tab changes so OutlinePanel always
 *     drives the CURRENTLY active editor instance.
 */
import { create } from "zustand";

import type { HeadingInfo } from "../editor/outlineExtract";

export interface OutlineStore {
  outlineHeadings: HeadingInfo[];
  setOutlineHeadings: (headings: HeadingInfo[]) => void;
  scrollToHeading: ((from: number) => void) | null;
  setScrollToHeading: (fn: ((from: number) => void) | null) => void;
}

export const useOutlineStore = create<OutlineStore>((set) => ({
  outlineHeadings: [],
  setOutlineHeadings: (headings) => set({ outlineHeadings: headings }),
  scrollToHeading: null,
  setScrollToHeading: (fn) => set({ scrollToHeading: fn }),
}));
