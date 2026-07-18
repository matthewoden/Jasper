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

/** Foreign-strip positional insertion target (P26 Obsidian-parity tab-bar drop). */
export interface StripHover {
  leafId: string;
  index: number;
  indicatorX: number;
}

export interface PaneDragStore {
  activeDrag: ActiveDrag | null;
  hover: Hover | null;
  stripHover: StripHover | null;
  beginDrag: (sourceLeafId: string, tabId: string) => void;
  setHover: (hover: Hover | null) => void;
  setStripHover: (stripHover: StripHover | null) => void;
  endDrag: () => void;
}

export const usePaneDragStore = create<PaneDragStore>((set) => ({
  activeDrag: null,
  hover: null,
  stripHover: null,

  beginDrag: (sourceLeafId, tabId) =>
    set({ activeDrag: { sourceLeafId, tabId }, hover: null, stripHover: null }),

  setHover: (hover) => set({ hover }),

  setStripHover: (stripHover) => set({ stripHover }),

  endDrag: () => set({ activeDrag: null, hover: null, stripHover: null }),
}));
