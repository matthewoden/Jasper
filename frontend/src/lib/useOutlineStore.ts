/**
 * Deliberately NOT a useTreeStore slice: keeps the Outline panel from re-rendering
 * on tree/tab/search churn, and vice versa.
 *
 * Written by the ACTIVE editor only (EditorPane gates writes on
 * noteId === activeNoteId), so scrollToHeading always drives the visible view.
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
