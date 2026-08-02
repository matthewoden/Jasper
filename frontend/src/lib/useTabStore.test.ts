/**
 * Tests for useTabStore — zustand tab store with deferred, vault-scoped
 * localStorage persistence (debounced 250ms).
 *
 * Covers TAB-01 (open/append/active), TAB-02 (dedup), TAB-03 (reorder),
 * TAB-12 (markDeleted immutability), TAB-10 (per-vault persistence round-trip,
 * corruption tolerance, cross-vault isolation), and pruneTabsForMissingNotes
 * (keep-deleted drop-missing).
 *
 * The persistence subscribe is deferred to initForVault(); tests that exercise
 * writes call initForVault first to activate it, then drive the 250ms debounce
 * with fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  pruneTabsForMissingNotes,
  tabsKeyForVault,
  useTabStore,
} from "./useTabStore";

function resetStore() {
  useTabStore.setState({
    tabs: [],
    activeTabId: null,
    deletedTabIds: new Set<string>(),
  });
}

describe("useTabStore — open / dedup / active (TAB-01, TAB-02)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("openTab appends a tab and sets it active", () => {
    useTabStore.getState().openTab("note-a");
    const s = useTabStore.getState();
    expect(s.tabs).toEqual([{ id: "note-a", noteId: "note-a" }]);
    expect(s.activeTabId).toBe("note-a");
  });

  it("opening two distinct notes appends both, last is active", () => {
    useTabStore.getState().openTab("note-a");
    useTabStore.getState().openTab("note-b");
    const s = useTabStore.getState();
    expect(s.tabs.map((t) => t.noteId)).toEqual(["note-a", "note-b"]);
    expect(s.activeTabId).toBe("note-b");
  });

  it("re-opening an already-open note dedups and just switches active (TAB-02)", () => {
    const { openTab } = useTabStore.getState();
    openTab("note-a");
    openTab("note-b");
    openTab("note-a"); // re-open A
    const s = useTabStore.getState();
    expect(s.tabs.length).toBe(1 + 1); // still two tabs, no duplicate
    expect(s.tabs.map((t) => t.noteId)).toEqual(["note-a", "note-b"]);
    expect(s.activeTabId).toBe("note-a");
  });
});

describe("useTabStore — close / re-target active", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("closing the active tab re-targets to the left neighbour", () => {
    const { openTab, closeTab } = useTabStore.getState();
    openTab("a");
    openTab("b");
    openTab("c"); // active = c
    closeTab("c");
    expect(useTabStore.getState().activeTabId).toBe("b");
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("closing the last remaining tab sets active to null", () => {
    const { openTab, closeTab } = useTabStore.getState();
    openTab("only");
    closeTab("only");
    expect(useTabStore.getState().activeTabId).toBeNull();
    expect(useTabStore.getState().tabs).toEqual([]);
  });

  it("closing a non-active tab leaves active untouched", () => {
    const { openTab, closeTab, setActiveTab } = useTabStore.getState();
    openTab("a");
    openTab("b");
    setActiveTab("a");
    closeTab("b");
    expect(useTabStore.getState().activeTabId).toBe("a");
  });

  it("closing an unknown tab id is a no-op", () => {
    const { openTab, closeTab } = useTabStore.getState();
    openTab("a");
    closeTab("does-not-exist");
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("useTabStore — cycleTab (TAB-11 store half)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("is a no-op with fewer than two tabs", () => {
    useTabStore.getState().openTab("only");
    useTabStore.getState().cycleTab(1);
    expect(useTabStore.getState().activeTabId).toBe("only");
  });

  it("wraps forward past the end", () => {
    const { openTab, setActiveTab, cycleTab } = useTabStore.getState();
    openTab("a");
    openTab("b");
    openTab("c");
    setActiveTab("c");
    cycleTab(1);
    expect(useTabStore.getState().activeTabId).toBe("a");
  });

  it("wraps backward past the start", () => {
    const { openTab, setActiveTab, cycleTab } = useTabStore.getState();
    openTab("a");
    openTab("b");
    setActiveTab("a");
    cycleTab(-1);
    expect(useTabStore.getState().activeTabId).toBe("b");
  });
});

describe("useTabStore — reorderTabs (TAB-03)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("moves the first tab to index 2", () => {
    const { openTab, reorderTabs } = useTabStore.getState();
    openTab("a");
    openTab("b");
    openTab("c");
    reorderTabs(0, 2);
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("moves a later tab to the front", () => {
    const { openTab, reorderTabs } = useTabStore.getState();
    openTab("a");
    openTab("b");
    openTab("c");
    reorderTabs(2, 0);
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });
});

describe("useTabStore — markDeleted (TAB-12)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("adds the noteId to deletedTabIds", () => {
    useTabStore.getState().markDeleted("gone");
    expect(useTabStore.getState().deletedTabIds.has("gone")).toBe(true);
  });

  it("produces a NEW Set instance (immutability)", () => {
    const before = useTabStore.getState().deletedTabIds;
    useTabStore.getState().markDeleted("gone");
    const after = useTabStore.getState().deletedTabIds;
    expect(after).not.toBe(before);
    expect(before.has("gone")).toBe(false); // old reference untouched
  });
});

describe("useTabStore — clearAllTabs", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("resets tabs, active, and deleted set", () => {
    const { openTab, markDeleted, clearAllTabs } = useTabStore.getState();
    openTab("a");
    markDeleted("a");
    clearAllTabs();
    const s = useTabStore.getState();
    expect(s.tabs).toEqual([]);
    expect(s.activeTabId).toBeNull();
    expect(s.deletedTabIds.size).toBe(0);
  });
});

describe("useTabStore — per-vault persistence (TAB-10)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initForVault hydrates tabs + active from a seeded key", () => {
    const vault = "/Users/me/vault one";
    localStorage.setItem(
      tabsKeyForVault(vault),
      JSON.stringify({ tabIds: ["x", "y"], activeTabId: "y" }),
    );
    useTabStore.getState().initForVault(vault);
    const s = useTabStore.getState();
    expect(s.tabs.map((t) => t.noteId)).toEqual(["x", "y"]);
    expect(s.activeTabId).toBe("y");
  });

  it("init falls back to first tab when persisted active is stale", () => {
    const vault = "/v";
    localStorage.setItem(
      tabsKeyForVault(vault),
      JSON.stringify({ tabIds: ["x", "y"], activeTabId: "not-present" }),
    );
    useTabStore.getState().initForVault(vault);
    expect(useTabStore.getState().activeTabId).toBe("x");
  });

  it("debounced write lands under the encoded key (250ms)", () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const vault = "/Users/me/vault one";
    const key = tabsKeyForVault(vault);

    useTabStore.getState().initForVault(vault); // activates subscribe
    useTabStore.getState().openTab("note-a");
    vi.advanceTimersByTime(260);

    const lastTabsWrite = setItemSpy.mock.calls.filter((c) => c[0] === key).pop();
    expect(lastTabsWrite).toBeDefined();
    expect(lastTabsWrite?.[0]).toBe(key);
    expect(JSON.parse(String(lastTabsWrite?.[1]))).toEqual({
      tabIds: ["note-a"],
      activeTabId: "note-a",
    });
  });

  it("corrupt persisted JSON yields empty tabs and does NOT throw", () => {
    const vault = "/v";
    localStorage.setItem(tabsKeyForVault(vault), "not json{");
    expect(() => useTabStore.getState().initForVault(vault)).not.toThrow();
    expect(useTabStore.getState().tabs.length).toBe(0);
  });

  it("non-string tabIds entries are filtered out", () => {
    const vault = "/v";
    localStorage.setItem(
      tabsKeyForVault(vault),
      JSON.stringify({ tabIds: ["ok", 42, null, "ok2"], activeTabId: "ok" }),
    );
    useTabStore.getState().initForVault(vault);
    expect(useTabStore.getState().tabs.map((t) => t.noteId)).toEqual(["ok", "ok2"]);
  });

  it("vault A and vault B use distinct keys and tabs do not bleed", () => {
    vi.useFakeTimers();
    const a = "/vault/a";
    const b = "/vault/b";
    expect(tabsKeyForVault(a)).not.toBe(tabsKeyForVault(b));

    // Seed vault A, init, mutate, flush.
    useTabStore.getState().initForVault(a);
    useTabStore.getState().openTab("a-note");
    vi.advanceTimersByTime(260);

    // Switch to vault B (no persisted state) — A's tabs must not bleed in.
    useTabStore.getState().initForVault(b);
    expect(useTabStore.getState().tabs).toEqual([]);
    expect(useTabStore.getState().activeTabId).toBeNull();

    useTabStore.getState().openTab("b-note");
    vi.advanceTimersByTime(260);

    expect(JSON.parse(localStorage.getItem(tabsKeyForVault(a)) ?? "{}")).toEqual({
      tabIds: ["a-note"],
      activeTabId: "a-note",
    });
    expect(JSON.parse(localStorage.getItem(tabsKeyForVault(b)) ?? "{}")).toEqual({
      tabIds: ["b-note"],
      activeTabId: "b-note",
    });
  });
});

describe("pruneTabsForMissingNotes", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("drops tabs whose noteId is absent from the fresh tree", () => {
    const { openTab } = useTabStore.getState();
    openTab("a");
    openTab("b");
    openTab("c");
    pruneTabsForMissingNotes(new Set(["a", "c"]));
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("keeps a tab whose noteId is in deletedTabIds even when absent from the tree", () => {
    const { openTab, markDeleted } = useTabStore.getState();
    openTab("a");
    openTab("deleted-but-open");
    markDeleted("deleted-but-open");
    pruneTabsForMissingNotes(new Set(["a"])); // deleted note absent from tree
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual([
      "a",
      "deleted-but-open",
    ]);
  });

  it("re-targets active when the active tab was dropped", () => {
    const { openTab, setActiveTab } = useTabStore.getState();
    openTab("a");
    openTab("b");
    setActiveTab("b");
    pruneTabsForMissingNotes(new Set(["a"])); // b dropped
    expect(useTabStore.getState().activeTabId).toBe("a");
  });

  it("is a no-op (preserves reference identity) when nothing is missing", () => {
    const { openTab } = useTabStore.getState();
    openTab("a");
    openTab("b");
    const before = useTabStore.getState().tabs;
    pruneTabsForMissingNotes(new Set(["a", "b"]));
    expect(useTabStore.getState().tabs).toBe(before);
  });
});
