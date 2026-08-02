/**
 * useTabStore — the ordered, vault-scoped tab list.
 *
 * CRITICAL departure from useTreeStore: that store hydrates at module load
 * because its keys are global. This key is vault-scoped, so hydration and the
 * debounced subscribe are wired inside initForVault once the vault resolves.
 * There is deliberately NO module-level init here.
 *
 * deletedTabIds is live-session only and never persisted.
 */
import { create } from "zustand";

export interface Tab {
  // id === noteId (1:1 per TAB-02 dedup). Supporting duplicate tabs of one note
  // would mean decoupling id from noteId and re-resolving content per tab.
  id: string;
  noteId: string;
  // Pinned tabs: auto-group at the strip's left
  // edge, skip every bulk-close path, and refuse a direct close (pin glyph
  // replaces the close-×). Optional/undefined means "not pinned" — the vast
  // majority of tabs never set this field.
  pinned?: boolean;
}

export interface TabStore {
  tabs: Tab[];
  activeTabId: string | null;
  deletedTabIds: Set<string>; // live-session only; NEVER persisted

  openTab: (noteId: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  cycleTab: (direction: 1 | -1) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  markDeleted: (noteId: string) => void;
  clearAllTabs: () => void;
  initForVault: (vaultPath: string) => void;
}

export const tabsKeyForVault = (vaultPath: string): string =>
  `jasper.tabs.${encodeURIComponent(vaultPath)}`;

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  deletedTabIds: new Set<string>(),

  openTab: (noteId) => {
    const existing = get().tabs.find((t) => t.noteId === noteId);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const id = noteId; // 1:1 with noteId per TAB-02
    set((s) => ({ tabs: [...s.tabs, { id, noteId }], activeTabId: id }));
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const nextTabs = tabs.filter((t) => t.id !== tabId);
    let nextActiveId = activeTabId;
    if (activeTabId === tabId) {
      // Re-target to the left neighbour, or null when none remain.
      nextActiveId = nextTabs[Math.max(0, idx - 1)]?.id ?? null;
    }
    set((s) => {
      const nextDeleted = new Set(s.deletedTabIds);
      nextDeleted.delete(tabId);
      return { tabs: nextTabs, activeTabId: nextActiveId, deletedTabIds: nextDeleted };
    });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  cycleTab: (direction) => {
    const { tabs, activeTabId } = get();
    if (tabs.length < 2) return; // TAB-11: no-op below two tabs
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = (idx + direction + tabs.length) % tabs.length;
    set({ activeTabId: tabs[next].id });
  },

  reorderTabs: (fromIndex, toIndex) =>
    set((s) => {
      const next = [...s.tabs];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return { tabs: next };
    }),

  markDeleted: (noteId) =>
    set((s) => {
      const next = new Set(s.deletedTabIds);
      next.add(noteId);
      return { deletedTabIds: next };
    }),

  clearAllTabs: () =>
    set({ tabs: [], activeTabId: null, deletedTabIds: new Set<string>() }),

  initForVault: (vaultPath) => {
    const key = tabsKeyForVault(vaultPath);
    activeVaultKey = key;

    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as { tabIds?: unknown; activeTabId?: unknown };
        const tabIds = Array.isArray(parsed.tabIds)
          ? parsed.tabIds.filter((x): x is string => typeof x === "string")
          : [];
        const activeTabId =
          typeof parsed.activeTabId === "string" ? parsed.activeTabId : null;
        const tabs: Tab[] = tabIds.map((noteId) => ({ id: noteId, noteId }));
        set({
          tabs,
          activeTabId: tabs.some((t) => t.id === activeTabId)
            ? activeTabId
            : (tabs[0]?.id ?? null),
        });
      } else {
        // No persisted state for this vault — start empty (prevents bleed from a
        // prior vault's in-memory tabs when switching).
        set({ tabs: [], activeTabId: null });
      }
    } catch {
      // Corrupted storage — fall through to empty; do NOT throw.
      set({ tabs: [], activeTabId: null });
    }

    lastPersistedSnapshot = snapshotOf(useTabStore.getState());
    ensureSubscribed();
  },
}));

/**
 * pruneTabsForMissingNotes — drop tab UUIDs absent from the freshly-fetched tree,
 * mirroring pruneStaleTreeState. KEEP tabs whose noteId is in deletedTabIds even
 * when absent from the tree (a deleted note's tab stays open read-only for
 * the session). Re-targets activeTabId when it was dropped. Gated on change so a
 * no-op pass preserves reference identity.
 */
export function pruneTabsForMissingNotes(allNoteIds: Set<string>): void {
  const s = useTabStore.getState();
  const cleanTabs = s.tabs.filter(
    (t) => allNoteIds.has(t.noteId) || s.deletedTabIds.has(t.noteId),
  );
  if (cleanTabs.length === s.tabs.length) return; // nothing dropped

  const cleanActive = cleanTabs.some((t) => t.id === s.activeTabId)
    ? s.activeTabId
    : (cleanTabs[cleanTabs.length - 1]?.id ?? null);

  useTabStore.setState({ tabs: cleanTabs, activeTabId: cleanActive });
}

// --- Deferred, vault-scoped persistence -------------------------------------
// activeVaultKey is captured at initForVault time so the writer always targets
// the current vault's key even after a hot-swap. The subscribe is wired once
// (one-time flag) to avoid stacking listeners across repeated initForVault calls.

let activeVaultKey: string | null = null;
let subscribed = false;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let lastPersistedSnapshot = "";

function snapshotOf(state: TabStore): string {
  return JSON.stringify({
    tabIds: state.tabs.map((t) => t.noteId),
    activeTabId: state.activeTabId,
  });
}

function ensureSubscribed(): void {
  if (subscribed || typeof window === "undefined") return;
  subscribed = true;
  useTabStore.subscribe((state) => {
    const snap = snapshotOf(state);
    if (snap === lastPersistedSnapshot || activeVaultKey === null) return;
    lastPersistedSnapshot = snap;
    const key = activeVaultKey;
    if (writeTimer !== undefined) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      try {
        window.localStorage.setItem(key, snap);
      } catch {
        // Ignore quota / private-mode failures — persistence is best-effort.
      }
    }, 250);
  });
}
