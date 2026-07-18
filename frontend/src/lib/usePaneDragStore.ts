/**
 * usePaneDragStore — TRANSIENT cross-pane drag UI state (WS-01/WS-02, D-10/D-11).
 *
 * Deliberately NOT the persisted usePaneStore: no browser-storage write, no
 * subscribe/debounced write. This is purely the shared channel between the
 * dragging TabStrip (the source of pointer events) and every mounted
 * LeafPane (each independently deciding whether to render its drop-region
 * overlay). Cleared on every drag end/cancel so it never survives a reload
 * or leaks state across drags (mirrors the TabStrip stranded-drag safety
 * net in spirit, but at the store level).
 */
import { create } from "zustand";

export type DropRegion = "left" | "right" | "top" | "bottom" | "center";

export interface ActiveDrag {
  sourceLeafId: string;
  tabId: string;
}

export interface Hover {
  leafId: string;
  region: DropRegion;
}

export interface PaneDragStore {
  activeDrag: ActiveDrag | null;
  hover: Hover | null;
  beginDrag: (sourceLeafId: string, tabId: string) => void;
  setHover: (hover: Hover | null) => void;
  endDrag: () => void;
}

export const usePaneDragStore = create<PaneDragStore>((set) => ({
  activeDrag: null,
  hover: null,

  beginDrag: (sourceLeafId, tabId) =>
    set({ activeDrag: { sourceLeafId, tabId }, hover: null }),

  setHover: (hover) => set({ hover }),

  endDrag: () => set({ activeDrag: null, hover: null }),
}));
