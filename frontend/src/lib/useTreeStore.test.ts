/**
 * Tests for useTreeStore — zustand store with localStorage persistence (debounced 250ms).
 * Validates store shape, mutators, hydration tolerance for corrupted storage,
 * and the pruneStaleTreeState helper that useFileTree calls after every fetch.
 *
 * Persistence side-effects rely on window/localStorage (jsdom). Tests that
 * exercise the module-load hydration path use vi.resetModules() to force a
 * fresh import after seeding localStorage.
 */
import { act, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  LS_KEY_ACTIVE_NOTE,
  LS_KEY_EXPANDED,
  LS_KEY_LINKED_MENTIONS_HEIGHT_RATIO,
  LS_KEY_OUTLINE_HEIGHT_RATIO,
  LS_KEY_SIDEBAR_WIDTH,
  pruneStaleTreeState,
  SIDEBAR_WIDTH_DEFAULT,
  useTreeStore,
} from "./useTreeStore";

const FULL_DEFAULT_STATE = {
  expanded: new Set<string>(),
  activeNoteId: null,
  pendingRename: null,
  draftCreate: null,
  selectedRow: null,
  liveLabels: {} as Record<string, string>,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
};

describe("useTreeStore — default + mutators", () => {
  beforeEach(() => {
    localStorage.clear();
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
    });
  });

  it("TestStore_DefaultShape: starts with empty Set, null active, null transient slots", () => {
    const s = useTreeStore.getState();
    expect(s.expanded).toBeInstanceOf(Set);
    expect(s.expanded.size).toBe(0);
    expect(s.activeNoteId).toBeNull();
    expect(s.pendingRename).toBeNull();
    expect(s.draftCreate).toBeNull();
  });

  it("TestStore_ToggleExpanded_Adds: toggling a path adds it to the set", () => {
    const { result } = renderHook(() => useTreeStore());
    act(() => result.current.toggleExpanded("projects"));
    expect(result.current.expanded.has("projects")).toBe(true);
  });

  it("TestStore_ToggleExpanded_Removes: toggling a path twice removes it", () => {
    const { result } = renderHook(() => useTreeStore());
    act(() => {
      result.current.toggleExpanded("projects");
      result.current.toggleExpanded("projects");
    });
    expect(result.current.expanded.has("projects")).toBe(false);
    expect(result.current.expanded.size).toBe(0);
  });

  it("TestStore_SetActiveNote: setActiveNote stores the id; null clears it", () => {
    const { result } = renderHook(() => useTreeStore());
    act(() => result.current.setActiveNote("uuid-a"));
    expect(result.current.activeNoteId).toBe("uuid-a");
    act(() => result.current.setActiveNote(null));
    expect(result.current.activeNoteId).toBeNull();
  });

  it("TestStore_StartEndRename: pendingRename round-trips and clears", () => {
    const { result } = renderHook(() => useTreeStore());
    act(() => result.current.startRename("note", "uuid-x"));
    expect(result.current.pendingRename).toEqual({ kind: "note", target: "uuid-x" });
    act(() => result.current.endRename());
    expect(result.current.pendingRename).toBeNull();

    act(() => result.current.startRename("folder", "projects/jasper"));
    expect(result.current.pendingRename).toEqual({
      kind: "folder",
      target: "projects/jasper",
    });
    act(() => result.current.endRename());
    expect(result.current.pendingRename).toBeNull();
  });

  it("TestStore_StartEndDraftCreate: draftCreate round-trips and clears", () => {
    const { result } = renderHook(() => useTreeStore());
    act(() => result.current.startDraftCreate("folder", "projects"));
    expect(result.current.draftCreate).toEqual({
      kind: "folder",
      parent: "projects",
    });
    act(() => result.current.endDraftCreate());
    expect(result.current.draftCreate).toBeNull();
  });
});

describe("useTreeStore — localStorage hydration on module load", () => {
  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("TestStore_HydratesFromLocalStorage_Expanded: pre-seeded array becomes the Set", async () => {
    localStorage.setItem(
      LS_KEY_EXPANDED,
      JSON.stringify(["projects", "ideas/sub"]),
    );
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    expect(s.expanded.has("projects")).toBe(true);
    expect(s.expanded.has("ideas/sub")).toBe(true);
    expect(s.expanded.size).toBe(2);
  });

  it("TestStore_HydratesFromLocalStorage_ActiveNote: pre-seeded id becomes activeNoteId", async () => {
    localStorage.setItem(
      LS_KEY_ACTIVE_NOTE,
      JSON.stringify("00000000-0000-4000-a000-00000000abcd"),
    );
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    expect(s.activeNoteId).toBe("00000000-0000-4000-a000-00000000abcd");
  });

  it("TestStore_CorruptedLocalStorage_FallsBackToDefault: bad JSON does not throw", async () => {
    localStorage.setItem(LS_KEY_EXPANDED, "not json{");
    localStorage.setItem(LS_KEY_ACTIVE_NOTE, "alsobad{");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    expect(s.expanded.size).toBe(0);
    expect(s.activeNoteId).toBeNull();
  });

  it("TestStore_LocalStorageKeysExact: the two keys are LITERAL strings expected by UI-SPEC", () => {
    expect(LS_KEY_EXPANDED).toBe("jasper.tree.expanded");
    expect(LS_KEY_ACTIVE_NOTE).toBe("jasper.tree.activeNoteId");
  });
});

describe("useTreeStore — debounced persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("TestStore_DebouncesPersistence: 5 toggles within 100ms commit ONCE after 250ms", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    act(() => {
      useTreeStore.getState().toggleExpanded("a");
      useTreeStore.getState().toggleExpanded("b");
      useTreeStore.getState().toggleExpanded("c");
      useTreeStore.getState().toggleExpanded("d");
      useTreeStore.getState().toggleExpanded("e");
    });

    const writesBeforeFlush = setItemSpy.mock.calls.filter(
      (c) => c[0] === LS_KEY_EXPANDED,
    ).length;
    expect(writesBeforeFlush).toBe(0);

    act(() => {
      vi.advanceTimersByTime(260);
    });

    const writesAfterFlush = setItemSpy.mock.calls.filter(
      (c) => c[0] === LS_KEY_EXPANDED,
    ).length;
    expect(writesAfterFlush).toBe(1);

    setItemSpy.mockRestore();
  });

  it("TestStore_PersistsActiveNoteAfterDebounce: setActiveNote writes the right key", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    act(() => {
      useTreeStore.getState().setActiveNote("uuid-foo");
    });
    act(() => {
      vi.advanceTimersByTime(260);
    });

    const lastWriteForKey = setItemSpy.mock.calls
      .filter((c) => c[0] === LS_KEY_ACTIVE_NOTE)
      .pop();
    expect(lastWriteForKey?.[1]).toBe(JSON.stringify("uuid-foo"));

    setItemSpy.mockRestore();
  });
});

describe("pruneStaleTreeState", () => {
  beforeEach(() => {
    localStorage.clear();
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
    });
  });

  it("TestPruneStaleTreeState_DropsUnknownExpanded: stale folder paths are removed", () => {
    useTreeStore.setState({
      expanded: new Set(["a", "b", "c"]),
    });
    pruneStaleTreeState(new Set(["a", "c"]), new Set());
    const after = useTreeStore.getState().expanded;
    expect(after.has("a")).toBe(true);
    expect(after.has("c")).toBe(true);
    expect(after.has("b")).toBe(false);
    expect(after.size).toBe(2);
  });

  it("TestPruneStaleTreeState_ClearsStaleActiveNote: unknown id becomes null", () => {
    useTreeStore.setState({ activeNoteId: "missing-uuid" });
    pruneStaleTreeState(new Set(), new Set(["other-uuid"]));
    expect(useTreeStore.getState().activeNoteId).toBeNull();
  });

  it("TestPruneStaleTreeState_KeepsValidActiveNote: present id stays put", () => {
    useTreeStore.setState({ activeNoteId: "good-uuid" });
    pruneStaleTreeState(new Set(), new Set(["good-uuid", "other"]));
    expect(useTreeStore.getState().activeNoteId).toBe("good-uuid");
  });

  it("TestPruneStaleTreeState_NoOpWhenAllPresent: identical state means no setState fires", () => {
    useTreeStore.setState({
      expanded: new Set(["a"]),
      activeNoteId: "uuid-x",
    });
    const before = useTreeStore.getState();
    pruneStaleTreeState(new Set(["a"]), new Set(["uuid-x"]));
    const after = useTreeStore.getState();
    expect(after.expanded).toBe(before.expanded);
    expect(after.activeNoteId).toBe(before.activeNoteId);
  });
});


describe("useTreeStore — selectedRow (Gap R2-4)", () => {
  beforeEach(() => {
    localStorage.clear();
    useTreeStore.setState(FULL_DEFAULT_STATE);
  });

  it("TestStore_SelectedRow_DefaultIsNull", () => {
    expect(useTreeStore.getState().selectedRow).toBeNull();
  });

  it("TestStore_SetSelectedRow_Note: sets {kind:'note', target:<id>}", () => {
    const { result } = renderHook(() => useTreeStore());
    act(() =>
      result.current.setSelectedRow({ kind: "note", target: "abc-uuid" }),
    );
    expect(result.current.selectedRow).toEqual({
      kind: "note",
      target: "abc-uuid",
    });
  });

  it("TestStore_SetSelectedRow_Folder: sets {kind:'folder', target:<path>}", () => {
    const { result } = renderHook(() => useTreeStore());
    act(() =>
      result.current.setSelectedRow({
        kind: "folder",
        target: "projects/jasper",
      }),
    );
    expect(result.current.selectedRow).toEqual({
      kind: "folder",
      target: "projects/jasper",
    });
  });

  it("TestStore_SetSelectedRow_Null: clears the slot", () => {
    const { result } = renderHook(() => useTreeStore());
    act(() =>
      result.current.setSelectedRow({ kind: "note", target: "abc-uuid" }),
    );
    expect(result.current.selectedRow).not.toBeNull();
    act(() => result.current.setSelectedRow(null));
    expect(result.current.selectedRow).toBeNull();
  });

  it("TestStore_SelectedRow_NotPersisted: setSelectedRow does NOT touch localStorage", () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      act(() => {
        useTreeStore.getState().setSelectedRow({
          kind: "note",
          target: "abc-uuid",
        });
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const writes = setItemSpy.mock.calls.map((c) => c[0]);
      expect(
        writes.some(
          (k) =>
            typeof k === "string" &&
            k.toLowerCase().includes("selectedrow"),
        ),
      ).toBe(false);
      expect(writes).not.toContain(LS_KEY_EXPANDED);
      expect(writes).not.toContain(LS_KEY_ACTIVE_NOTE);
    } finally {
      setItemSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("TestStore_PreExistingSlots_StillWork — adding selectedRow is purely additive", () => {
    const { result } = renderHook(() => useTreeStore());
    act(() => {
      result.current.toggleExpanded("projects");
      result.current.setActiveNote("uuid-foo");
      result.current.startRename("note", "uuid-bar");
      result.current.startDraftCreate("folder", "ideas");
      result.current.setSelectedRow({ kind: "note", target: "uuid-zzz" });
    });
    const s = result.current;
    expect(s.expanded.has("projects")).toBe(true);
    expect(s.activeNoteId).toBe("uuid-foo");
    expect(s.pendingRename).toEqual({ kind: "note", target: "uuid-bar" });
    expect(s.draftCreate).toEqual({ kind: "folder", parent: "ideas" });
    expect(s.selectedRow).toEqual({ kind: "note", target: "uuid-zzz" });
  });


  it("UX-08: setLiveLabel adds an entry keyed by note id", () => {
    useTreeStore.getState().setLiveLabel("note-a", "Hello");
    expect(useTreeStore.getState().liveLabels["note-a"]).toBe("Hello");
  });

  it("UX-08: clearLiveLabel removes the entry; absent id is a no-op preserving object identity", () => {
    useTreeStore.getState().setLiveLabel("note-a", "Hello");
    expect(useTreeStore.getState().liveLabels["note-a"]).toBe("Hello");
    useTreeStore.getState().clearLiveLabel("note-a");
    expect(useTreeStore.getState().liveLabels["note-a"]).toBeUndefined();

    const stateBefore = useTreeStore.getState();
    const labelsBefore = stateBefore.liveLabels;
    useTreeStore.getState().clearLiveLabel("definitely-not-here");
    const stateAfter = useTreeStore.getState();
    expect(stateAfter.liveLabels).toBe(labelsBefore);
    expect(stateAfter).toBe(stateBefore);
  });

  it("UX-08: pruneStaleTreeState drops labels whose ids no longer exist in the tree", () => {
    useTreeStore.setState({
      liveLabels: { a: "A", b: "B", c: "C" },
    });
    pruneStaleTreeState(new Set(), new Set(["a"]));
    const labels = useTreeStore.getState().liveLabels;
    expect(labels.a).toBe("A");
    expect(labels.b).toBeUndefined();
    expect(labels.c).toBeUndefined();
    expect(Object.keys(labels)).toEqual(["a"]);
  });

  it("UX-09: setSidebarWidth clamps to SIDEBAR_WIDTH_DEFAULT (MIN)", async () => {
    const { setSidebarWidth } = useTreeStore.getState();
    setSidebarWidth(100);
    expect(useTreeStore.getState().sidebarWidth).toBe(260);
    setSidebarWidth(400);
    expect(useTreeStore.getState().sidebarWidth).toBe(400);
  });

  it("UX-09: LS_KEY_SIDEBAR_WIDTH is the LITERAL string expected by Plan 05", () => {
    expect(LS_KEY_SIDEBAR_WIDTH).toBe("jasper.sidebar.width");
  });

  it("TestPruneStaleTreeState_DoesNotTouchSelectedRow", () => {
    useTreeStore.setState({
      expanded: new Set(["a"]),
      activeNoteId: "uuid-keep",
      selectedRow: { kind: "note", target: "uuid-zzz" },
    });
    pruneStaleTreeState(new Set(["a"]), new Set(["uuid-keep"]));
    expect(useTreeStore.getState().selectedRow).toEqual({
      kind: "note",
      target: "uuid-zzz",
    });
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: "ghost-uuid",
      selectedRow: { kind: "folder", target: "projects" },
    });
    pruneStaleTreeState(new Set(), new Set());
    expect(useTreeStore.getState().selectedRow).toEqual({
      kind: "folder",
      target: "projects",
    });
    expect(useTreeStore.getState().activeNoteId).toBeNull();
  });
});


describe("useTreeStore — UX-09 sidebarWidth LS hydration + persistence", () => {
  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("UX-09: hydrates sidebarWidth from localStorage on module load", async () => {
    localStorage.setItem(LS_KEY_SIDEBAR_WIDTH, JSON.stringify(420));
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarWidth).toBe(420);
  });

  it("UX-09: clamps hydrated width below MIN up to MIN (A8)", async () => {
    localStorage.setItem(LS_KEY_SIDEBAR_WIDTH, JSON.stringify(100));
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarWidth).toBe(260);
  });

  it("BL-03: hydration clamps wide-monitor 1200px persisted width against narrow 900px viewport", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 900,
    });
    localStorage.setItem(LS_KEY_SIDEBAR_WIDTH, JSON.stringify(1200));
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarWidth).toBe(580);
  });

  it("BL-03: hydration leaves persisted 1200px width alone on a wide 1600px viewport", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1600,
    });
    localStorage.setItem(LS_KEY_SIDEBAR_WIDTH, JSON.stringify(1200));
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarWidth).toBe(1200);
  });

  it("BL-03: hydration with a degenerate sub-EDITOR_MIN viewport (400px) clamps to (innerWidth - EDITOR_MIN) = 80", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 400,
    });
    localStorage.setItem(LS_KEY_SIDEBAR_WIDTH, JSON.stringify(1200));
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarWidth).toBe(80);
  });

  it("BL-03: hydration of a below-MIN persisted width still clamps UP to MIN (existing rule preserved)", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
    localStorage.setItem(LS_KEY_SIDEBAR_WIDTH, JSON.stringify(200));
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarWidth).toBe(260);
  });

  it("BL-03: no localStorage entry → store stays at SIDEBAR_WIDTH_DEFAULT (no hydration ran)", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("UX-09: setSidebarWidth triggers debounced LS write", () => {
    localStorage.clear();
    vi.useFakeTimers();
    try {
      act(() => {
        useTreeStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
      });
      act(() => {
        vi.advanceTimersByTime(260);
      });

      const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
      try {
        act(() => {
          useTreeStore.getState().setSidebarWidth(380);
        });
        const writesBeforeFlush = setItemSpy.mock.calls.filter(
          (c) => c[0] === LS_KEY_SIDEBAR_WIDTH,
        ).length;
        expect(writesBeforeFlush).toBe(0);
        act(() => {
          vi.advanceTimersByTime(260);
        });
        const lastWriteForKey = setItemSpy.mock.calls
          .filter((c) => c[0] === LS_KEY_SIDEBAR_WIDTH)
          .pop();
        expect(lastWriteForKey?.[1]).toBe(JSON.stringify(380));
      } finally {
        setItemSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});


describe("Phase 10 — setActiveTagFilter normalization seam (DEBT-02)", () => {
  beforeEach(() => {
    localStorage.clear();
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
      activeTagFilter: null,
    });
  });

  it("TestStore_SetActiveTagFilter_StripsSingleLeadingHash: '#foo' stores as 'foo'", () => {
    useTreeStore.getState().setActiveTagFilter("#foo");
    expect(useTreeStore.getState().activeTagFilter).toBe("foo");
  });

  it("TestStore_SetActiveTagFilter_StripsRepeatedLeadingHashes: '##foo' stores as 'foo'", () => {
    useTreeStore.getState().setActiveTagFilter("##foo");
    expect(useTreeStore.getState().activeTagFilter).toBe("foo");
  });

  it("TestStore_SetActiveTagFilter_BareInputUnchanged: 'foo' stores as 'foo'", () => {
    useTreeStore.getState().setActiveTagFilter("foo");
    expect(useTreeStore.getState().activeTagFilter).toBe("foo");
  });

  it("TestStore_SetActiveTagFilter_NullClearsFilter: null stores as null (no crash)", () => {
    useTreeStore.getState().setActiveTagFilter("foo");
    expect(useTreeStore.getState().activeTagFilter).toBe("foo");
    useTreeStore.getState().setActiveTagFilter(null);
    expect(useTreeStore.getState().activeTagFilter).toBeNull();
  });
});


describe("Phase 6 — useTreeStore ADD-only slices", () => {
  beforeEach(() => {
    localStorage.clear();
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    vi.resetModules();
  });

  it("S1: fresh store returns tagBrowserExpanded=false, activeTagFilter=null, backlinksRailExpanded=true (D-06 default-visible), backlinksRailWidth=280", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    expect(s.tagBrowserExpanded).toBe(false);
    expect(s.activeTagFilter).toBeNull();
    expect(s.backlinksRailExpanded).toBe(true);
    expect(s.backlinksRailWidth).toBe(280);
  });

  it("S2: setTagBrowserExpanded(true) updates the store", () => {
    useTreeStore.getState().setTagBrowserExpanded(true);
    expect(useTreeStore.getState().tagBrowserExpanded).toBe(true);
    useTreeStore.getState().setTagBrowserExpanded(false);
    expect(useTreeStore.getState().tagBrowserExpanded).toBe(false);
  });

  it("S2: setBacklinksRailWidth(350) stores 350 (within min/max bounds)", () => {
    useTreeStore.getState().setBacklinksRailWidth(350);
    expect(useTreeStore.getState().backlinksRailWidth).toBe(350);
  });

  it("S3: setBacklinksRailWidth(100) clamps up to RAIL_MIN_WIDTH (220)", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    mod.useTreeStore.getState().setBacklinksRailWidth(100);
    expect(mod.useTreeStore.getState().backlinksRailWidth).toBe(mod.RAIL_MIN_WIDTH);
  });

  it("S3: setBacklinksRailWidth(900) clamps down to RAIL_MAX_WIDTH (480)", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    mod.useTreeStore.getState().setBacklinksRailWidth(900);
    expect(mod.useTreeStore.getState().backlinksRailWidth).toBe(mod.RAIL_MAX_WIDTH);
  });

  it("S4: pre-seeded backlinksRailWidth in LS hydrates on module load", async () => {
    localStorage.setItem("jasper.backlinks.rail.width", "350");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().backlinksRailWidth).toBe(350);
  });

  it("S5: pre-seeded tagBrowserExpanded=true in LS hydrates on module load", async () => {
    localStorage.setItem("jasper.tag.browser.expanded", "true");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().tagBrowserExpanded).toBe(true);
  });

  it("S6: pre-seeded backlinksRailWidth='garbage' falls back to RAIL_DEFAULT_WIDTH (280)", async () => {
    localStorage.setItem("jasper.backlinks.rail.width", "garbage");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().backlinksRailWidth).toBe(280);
  });

  it("S6: pre-seeded backlinksRailWidth out of range falls back to RAIL_DEFAULT_WIDTH (280)", async () => {
    localStorage.setItem("jasper.backlinks.rail.width", "50");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().backlinksRailWidth).toBe(280);
  });

  it("S7: setTagBrowserExpanded(true) persists to LS after debounce", () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      act(() => {
        useTreeStore.getState().setTagBrowserExpanded(true);
      });
      act(() => { vi.advanceTimersByTime(260); });
      const writes = setItemSpy.mock.calls.filter(c => c[0] === "jasper.tag.browser.expanded");
      expect(writes.length).toBeGreaterThan(0);
      expect(writes[writes.length - 1][1]).toBe("true");
    } finally {
      setItemSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("S8: setBacklinksRailWidth(300) persists to LS after debounce", () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      act(() => {
        useTreeStore.getState().setBacklinksRailWidth(300);
      });
      act(() => { vi.advanceTimersByTime(260); });
      const writes = setItemSpy.mock.calls.filter(c => c[0] === "jasper.backlinks.rail.width");
      expect(writes.length).toBeGreaterThan(0);
      expect(writes[writes.length - 1][1]).toBe("300");
    } finally {
      setItemSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("S9: setActiveTagFilter does NOT write to localStorage", () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      act(() => {
        useTreeStore.getState().setActiveTagFilter("foo");
      });
      act(() => { vi.advanceTimersByTime(500); });
      const allWrites = setItemSpy.mock.calls.map(c => c[0] as string);
      expect(allWrites.some(k => k.includes("filter"))).toBe(false);
    } finally {
      setItemSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("S9: activeTagFilter stays null on fresh module load (not persisted)", async () => {
    localStorage.setItem("jasper.tag.filter", "somefilter");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().activeTagFilter).toBeNull();
  });

  it("S10: existing slices still work correctly after Phase 6 additions (regression guard)", () => {
    const { result } = renderHook(() => useTreeStore());
    act(() => {
      result.current.toggleExpanded("projects");
      result.current.setActiveNote("uuid-foo");
      result.current.startRename("note", "uuid-bar");
      result.current.setSelectedRow({ kind: "note", target: "uuid-zzz" });
      result.current.setTagBrowserExpanded(true);
      result.current.setActiveTagFilter("my-tag");
      result.current.setBacklinksRailExpanded(true);
      result.current.setBacklinksRailWidth(320);
    });
    const s = result.current;
    expect(s.expanded.has("projects")).toBe(true);
    expect(s.activeNoteId).toBe("uuid-foo");
    expect(s.pendingRename).toEqual({ kind: "note", target: "uuid-bar" });
    expect(s.selectedRow).toEqual({ kind: "note", target: "uuid-zzz" });
    expect(s.tagBrowserExpanded).toBe(true);
    expect(s.activeTagFilter).toBe("my-tag");
    expect(s.backlinksRailExpanded).toBe(true);
    expect(s.backlinksRailWidth).toBe(320);
  });
});


describe("Phase 6.6 chrome slices", () => {
  beforeEach(() => {
    localStorage.clear();
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    vi.resetModules();
  });

  it("C1: fresh store returns notesSidebarVisible=true", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    expect(s.notesSidebarVisible).toBe(true);
  });

  it("C2: setNotesSidebarVisible(false) flips the slice; setNotesSidebarVisible(true) restores it", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    mod.useTreeStore.getState().setNotesSidebarVisible(false);
    expect(mod.useTreeStore.getState().notesSidebarVisible).toBe(false);
    mod.useTreeStore.getState().setNotesSidebarVisible(true);
    expect(mod.useTreeStore.getState().notesSidebarVisible).toBe(true);
  });

  it("C4: setNotesSidebarVisible(false) immediately writes 'false' to LS_KEY_SIDEBAR_VISIBLE", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    vi.useRealTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      act(() => {
        mod.useTreeStore.getState().setNotesSidebarVisible(false);
      });
      const writes = setItemSpy.mock.calls.filter(
        (c) => c[0] === mod.LS_KEY_SIDEBAR_VISIBLE,
      );
      expect(writes.length).toBeGreaterThan(0);
      expect(writes[writes.length - 1][1]).toBe("false");
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it("C5: pre-seeded LS_KEY_SIDEBAR_VISIBLE='false' yields notesSidebarVisible=false on load", async () => {
    localStorage.setItem("jasper.chrome.sidebar.visible", "false");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().notesSidebarVisible).toBe(false);
  });

  it("C5: absent LS key → notesSidebarVisible defaults to true", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().notesSidebarVisible).toBe(true);
  });

  it("C6: ADD-ONLY — backlinksRailExpanded defaults true (D-06, Phase 20)", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    expect(s.backlinksRailExpanded).toBe(true);
  });

  it("C7: LS key constants have expected literal string values", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.LS_KEY_SIDEBAR_VISIBLE).toBe("jasper.chrome.sidebar.visible");
  });
});


describe("WR-07 pruneStaleTreeState liveLabels rebuild (Phase 5.5 gap-closure Plan 13)", () => {
  beforeEach(() => {
    localStorage.clear();
    useTreeStore.setState(FULL_DEFAULT_STATE);
  });

  it("WR-07 / Test 1: stale id removed, kept ids preserved, identity changes", () => {
    useTreeStore.setState({
      liveLabels: { a: "A", b: "B", c: "C" },
    });
    const before = useTreeStore.getState().liveLabels;
    pruneStaleTreeState(new Set<string>(), new Set(["a", "c"]));
    const after = useTreeStore.getState().liveLabels;
    expect(after).toEqual({ a: "A", c: "C" });
    expect(after).not.toBe(before);
    expect(Object.keys(after)).toEqual(["a", "c"]);
    expect("b" in after).toBe(false);
  });

  it("WR-07 / Test 2: no-op pass preserves liveLabels reference identity", () => {
    useTreeStore.setState({
      liveLabels: { a: "A" },
    });
    const before = useTreeStore.getState().liveLabels;
    pruneStaleTreeState(new Set<string>(), new Set(["a"]));
    const after = useTreeStore.getState().liveLabels;
    expect(after).toBe(before);
  });

  it("WR-07 / Test 3: empty liveLabels + empty allNoteIds is a no-op (identity preserved)", () => {
    useTreeStore.setState({ liveLabels: {} });
    const before = useTreeStore.getState().liveLabels;
    pruneStaleTreeState(new Set<string>(), new Set<string>());
    const after = useTreeStore.getState().liveLabels;
    expect(after).toBe(before);
  });

  it("WR-07 / Test 4: every id stale → liveLabels becomes {} and identity changes", () => {
    useTreeStore.setState({
      liveLabels: { a: "A", b: "B" },
    });
    const before = useTreeStore.getState().liveLabels;
    pruneStaleTreeState(new Set<string>(), new Set<string>());
    const after = useTreeStore.getState().liveLabels;
    expect(after).toEqual({});
    expect(after).not.toBe(before);
  });
});


describe("Phase 7 ADD-only slices", () => {
  beforeEach(() => {
    useTreeStore.setState({
      searchQuery: "",
      searchResults: [],
      searchActive: false,
      paletteOpen: false,
      paletteMode: "notes",
      recentlyOpenedNoteIds: [],
      dailyNoteLoading: false,
      cheatSheetOpen: false,
    });
    try {
      window.localStorage.removeItem("jasper:switcher:recency");
    } catch {
      // best-effort
    }
  });

  it("setSearchQuery updates the slice", () => {
    useTreeStore.getState().setSearchQuery("foo");
    expect(useTreeStore.getState().searchQuery).toBe("foo");
  });

  it("setPaletteMode toggles between notes and commands", () => {
    useTreeStore.getState().setPaletteMode("commands");
    expect(useTreeStore.getState().paletteMode).toBe("commands");
    useTreeStore.getState().setPaletteMode("notes");
    expect(useTreeStore.getState().paletteMode).toBe("notes");
  });

  it("UTS-PALETTE-SEARCH-1: setPaletteMode accepts 'search' as a third value", () => {
    useTreeStore.getState().setPaletteMode("search");
    expect(useTreeStore.getState().paletteMode).toBe("search");
  });

  it("UTS-PALETTE-SEARCH-2: setPaletteMode('search') + setPaletteOpen(true) opens the modal in search mode", () => {
    useTreeStore.getState().setPaletteMode("search");
    useTreeStore.getState().setPaletteOpen(true);
    expect(useTreeStore.getState().paletteMode).toBe("search");
    expect(useTreeStore.getState().paletteOpen).toBe(true);
  });

  it("Phase 22: setPaletteMode accepts 'all' as a fourth value", () => {
    useTreeStore.getState().setPaletteMode("all");
    expect(useTreeStore.getState().paletteMode).toBe("all");
    useTreeStore.getState().setPaletteMode("notes");
    expect(useTreeStore.getState().paletteMode).toBe("notes");
  });

  it("recordOpenedNote pushes new id to front", () => {
    const { recordOpenedNote } = useTreeStore.getState();
    recordOpenedNote("a");
    recordOpenedNote("b");
    recordOpenedNote("c");
    expect(useTreeStore.getState().recentlyOpenedNoteIds).toEqual(["c", "b", "a"]);
  });

  it("recordOpenedNote dedupes existing id (move-to-front)", () => {
    const { recordOpenedNote } = useTreeStore.getState();
    recordOpenedNote("a");
    recordOpenedNote("b");
    recordOpenedNote("a");
    expect(useTreeStore.getState().recentlyOpenedNoteIds).toEqual(["a", "b"]);
  });

  it("recordOpenedNote caps at 50", () => {
    const { recordOpenedNote } = useTreeStore.getState();
    for (let i = 0; i < 60; i++) recordOpenedNote(`id-${i}`);
    expect(useTreeStore.getState().recentlyOpenedNoteIds.length).toBe(50);
  });

  it("recentlyOpenedNoteIds persists to localStorage", async () => {
    useTreeStore.getState().recordOpenedNote("persisted-id");
    await new Promise((r) => setTimeout(r, 0));
    const stored = window.localStorage.getItem("jasper:switcher:recency");
    expect(stored).toContain("persisted-id");
  });
});


describe("useTreeStore — activeFilePath slice (Plan 07-32b)", () => {
  beforeEach(() => {
    localStorage.clear();
    useTreeStore.setState({
      activeFilePath: null,
      activeNoteId: null,
    });
  });

  it("TS-AFP-1: activeFilePath defaults to null", () => {
    expect(useTreeStore.getState().activeFilePath).toBeNull();
  });

  it("TS-AFP-2: setActiveFilePath('foo/bar.png') sets activeFilePath AND atomically clears activeNoteId", () => {
    useTreeStore.setState({ activeNoteId: "preexisting-note-uuid" });
    expect(useTreeStore.getState().activeNoteId).toBe("preexisting-note-uuid");

    useTreeStore.getState().setActiveFilePath("foo/bar.png");

    expect(useTreeStore.getState().activeFilePath).toBe("foo/bar.png");
    expect(useTreeStore.getState().activeNoteId).toBeNull();
  });

  it("TS-AFP-2b: setActiveFilePath(null) clears activeFilePath without touching activeNoteId", () => {
    useTreeStore.setState({
      activeFilePath: "foo/bar.png",
      activeNoteId: null,
    });
    useTreeStore.getState().setActiveFilePath(null);
    expect(useTreeStore.getState().activeFilePath).toBeNull();
    useTreeStore.setState({
      activeFilePath: "x.png",
      activeNoteId: "some-note-uuid",
    });
    useTreeStore.getState().setActiveFilePath(null);
    expect(useTreeStore.getState().activeFilePath).toBeNull();
    expect(useTreeStore.getState().activeNoteId).toBe("some-note-uuid");
  });

  it("TS-AFP-3: caller-side clearing pattern — setActiveFilePath(null) BEFORE setActiveNote(uuid) clears activeFilePath and sets activeNoteId", () => {
    useTreeStore.setState({
      activeFilePath: "foo/bar.png",
      activeNoteId: null,
    });

    useTreeStore.getState().setActiveFilePath(null);
    useTreeStore.getState().setActiveNote("uuid-1234");

    expect(useTreeStore.getState().activeFilePath).toBeNull();
    expect(useTreeStore.getState().activeNoteId).toBe("uuid-1234");
  });
});


describe("Phase 19 Plan 04 / Phase 27 Plan 03 — sidebarPanel persisted slice (LSIDE-02, NAV-01)", () => {
  beforeEach(() => {
    localStorage.clear();
    useTreeStore.setState({ sidebarPanel: "notes" });
  });

  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("SP-1: fresh store defaults sidebarPanel to 'notes'", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarPanel).toBe("notes");
  });

  it("SP-2: setSidebarPanel('search') updates the state to 'search'", () => {
    useTreeStore.getState().setSidebarPanel("search");
    expect(useTreeStore.getState().sidebarPanel).toBe("search");
    useTreeStore.getState().setSidebarPanel("notes");
    expect(useTreeStore.getState().sidebarPanel).toBe("notes");
  });

  it("SP-2b: setSidebarPanel('bookmarks') updates the state to 'bookmarks'", () => {
    useTreeStore.getState().setSidebarPanel("bookmarks");
    expect(useTreeStore.getState().sidebarPanel).toBe("bookmarks");
  });

  it("SP-3: pre-seeded LS_KEY_SIDEBAR_PANEL='search' hydrates sidebarPanel on module load", async () => {
    localStorage.setItem("jasper.chrome.sidebar.panel", "search");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarPanel).toBe("search");
  });

  it("SP-3b: pre-seeded LS_KEY_SIDEBAR_PANEL='bookmarks' hydrates sidebarPanel on module load", async () => {
    localStorage.setItem("jasper.chrome.sidebar.panel", "bookmarks");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarPanel).toBe("bookmarks");
  });

  it("SP-3: corrupt/unknown LS value falls back to default 'notes'", async () => {
    localStorage.setItem("jasper.chrome.sidebar.panel", "garbage");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarPanel).toBe("notes");
  });

  it("SP-3: absent LS key → sidebarPanel defaults to 'notes'", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarPanel).toBe("notes");
  });

  it("SP-4: setSidebarPanel('search') immediately writes to localStorage[LS_KEY_SIDEBAR_PANEL] (no debounce)", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      mod.useTreeStore.getState().setSidebarPanel("search");
      const writes = setItemSpy.mock.calls.filter(
        (c) => c[0] === mod.LS_KEY_SIDEBAR_PANEL,
      );
      expect(writes.length).toBeGreaterThan(0);
      expect(writes[writes.length - 1][1]).toBe("search");
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it("SP-5: LS_KEY_SIDEBAR_PANEL is the literal string 'jasper.chrome.sidebar.panel'", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.LS_KEY_SIDEBAR_PANEL).toBe("jasper.chrome.sidebar.panel");
  });

  it("SP-6: searchQuery/searchResults remain unpersisted (D-18) — no new LS write for them", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      mod.useTreeStore.getState().setSearchQuery("hello");
      mod.useTreeStore.getState().setSearchResults([]);
      const writes = setItemSpy.mock.calls.map((c) => c[0] as string);
      expect(writes.some((k) => k.toLowerCase().includes("search"))).toBe(false);
    } finally {
      setItemSpy.mockRestore();
    }
  });
});


describe("Phase 20 Plan 03 — unified right-rail collapse booleans + split ratios (RSIDE-01/02, D-06)", () => {
  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("RR-1: fresh install (no localStorage key) — backlinksRailExpanded defaults true", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().backlinksRailExpanded).toBe(true);
  });

  it("RR-2: stored 'false' for backlinksRailExpanded keeps the rail hidden", async () => {
    localStorage.setItem("jasper.backlinks.rail.expanded", "false");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().backlinksRailExpanded).toBe(false);
  });

  it("RR-3: fresh install — outlinePanelExpanded, linkedMentionsPanelExpanded, tagsPanelExpanded all default true", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    expect(s.outlinePanelExpanded).toBe(true);
    expect(s.linkedMentionsPanelExpanded).toBe(true);
    expect(s.tagsPanelExpanded).toBe(true);
  });

  it("RR-4: outlinePanelExpanded hydrates false from stored 'false'", async () => {
    localStorage.setItem(
      "jasper.rightrail.outline.expanded",
      "false",
    );
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().outlinePanelExpanded).toBe(false);
  });

  it("RR-5: linkedMentionsPanelExpanded hydrates false from stored 'false'", async () => {
    localStorage.setItem(
      "jasper.rightrail.linkedmentions.expanded",
      "false",
    );
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().linkedMentionsPanelExpanded).toBe(false);
  });

  it("RR-6: tagsPanelExpanded hydrates false from stored 'false'", async () => {
    localStorage.setItem(
      "jasper.rightrail.tags.expanded",
      "false",
    );
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().tagsPanelExpanded).toBe(false);
  });

  it("RR-7: setOutlinePanelExpanded/setLinkedMentionsPanelExpanded/setTagsPanelExpanded update state and write immediately (no debounce)", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      mod.useTreeStore.getState().setOutlinePanelExpanded(false);
      expect(mod.useTreeStore.getState().outlinePanelExpanded).toBe(false);
      mod.useTreeStore.getState().setLinkedMentionsPanelExpanded(false);
      expect(mod.useTreeStore.getState().linkedMentionsPanelExpanded).toBe(false);
      mod.useTreeStore.getState().setTagsPanelExpanded(false);
      expect(mod.useTreeStore.getState().tagsPanelExpanded).toBe(false);

      const writeKeys = setItemSpy.mock.calls.map((c) => c[0]);
      expect(writeKeys).toContain(mod.LS_KEY_OUTLINE_PANEL_EXPANDED);
      expect(writeKeys).toContain(mod.LS_KEY_LINKED_MENTIONS_PANEL_EXPANDED);
      expect(writeKeys).toContain(mod.LS_KEY_TAGS_PANEL_EXPANDED);
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it("RR-8: outlineHeightRatio + linkedMentionsHeightRatio default to 0.34 and clamp within [0.2, 0.8]", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    expect(s.outlineHeightRatio).toBe(0.34);
    expect(s.linkedMentionsHeightRatio).toBe(0.34);

    mod.useTreeStore.getState().setOutlineHeightRatio(0.05);
    expect(mod.useTreeStore.getState().outlineHeightRatio).toBe(mod.RIGHT_RAIL_RATIO_MIN);
    mod.useTreeStore.getState().setOutlineHeightRatio(0.95);
    expect(mod.useTreeStore.getState().outlineHeightRatio).toBe(mod.RIGHT_RAIL_RATIO_MAX);

    mod.useTreeStore.getState().setLinkedMentionsHeightRatio(0.05);
    expect(mod.useTreeStore.getState().linkedMentionsHeightRatio).toBe(mod.RIGHT_RAIL_RATIO_MIN);
    mod.useTreeStore.getState().setLinkedMentionsHeightRatio(0.95);
    expect(mod.useTreeStore.getState().linkedMentionsHeightRatio).toBe(mod.RIGHT_RAIL_RATIO_MAX);
  });

  it("RR-9: setOutlineHeightRatio/setLinkedMentionsHeightRatio persist to LS after 250ms debounce", () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      act(() => {
        useTreeStore.getState().setOutlineHeightRatio(0.4);
        useTreeStore.getState().setLinkedMentionsHeightRatio(0.45);
      });
      const writesBeforeFlush = setItemSpy.mock.calls.filter(
        (c) => c[0] === LS_KEY_OUTLINE_HEIGHT_RATIO || c[0] === LS_KEY_LINKED_MENTIONS_HEIGHT_RATIO,
      ).length;
      expect(writesBeforeFlush).toBe(0);
      act(() => {
        vi.advanceTimersByTime(260);
      });
      const outlineWrites = setItemSpy.mock.calls.filter(
        (c) => c[0] === LS_KEY_OUTLINE_HEIGHT_RATIO,
      );
      const linkedMentionsWrites = setItemSpy.mock.calls.filter(
        (c) => c[0] === LS_KEY_LINKED_MENTIONS_HEIGHT_RATIO,
      );
      expect(outlineWrites.length).toBeGreaterThan(0);
      expect(outlineWrites[outlineWrites.length - 1][1]).toBe("0.4");
      expect(linkedMentionsWrites.length).toBeGreaterThan(0);
      expect(linkedMentionsWrites[linkedMentionsWrites.length - 1][1]).toBe("0.45");
    } finally {
      setItemSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("RR-10: pre-seeded outlineHeightRatio hydrates on module load; out-of-range falls back to default", async () => {
    localStorage.setItem(LS_KEY_OUTLINE_HEIGHT_RATIO, "0.6");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().outlineHeightRatio).toBe(0.6);

    localStorage.clear();
    localStorage.setItem(LS_KEY_OUTLINE_HEIGHT_RATIO, "1.5");
    vi.resetModules();
    const mod2 = await import("./useTreeStore");
    expect(mod2.useTreeStore.getState().outlineHeightRatio).toBe(0.34);
  });

  // RR-11 (Phase 20 Plan 03) asserted the legacy panel-selector slice was
  // unaffected by the additive-only plan; the slice itself was removed by
  // Plan 05 (D-01 fold), so that assertion no longer applies.
});


describe("Phase 22 Plan 01 — ephemeral zen slice (ZEN-01, D-08)", () => {
  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("Z1: fresh store defaults zen to false", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().zen).toBe(false);
  });

  it("Z2: toggleZen() flips false -> true -> false", () => {
    useTreeStore.setState({ zen: false });
    useTreeStore.getState().toggleZen();
    expect(useTreeStore.getState().zen).toBe(true);
    useTreeStore.getState().toggleZen();
    expect(useTreeStore.getState().zen).toBe(false);
  });

  it("Z3: setZen(true) sets zen to true", () => {
    useTreeStore.setState({ zen: false });
    useTreeStore.getState().setZen(true);
    expect(useTreeStore.getState().zen).toBe(true);
  });

  it("Z4: mutating zen does NOT write any key to localStorage", () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      useTreeStore.getState().toggleZen();
      useTreeStore.getState().setZen(true);
      useTreeStore.getState().setZen(false);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const writeKeys = setItemSpy.mock.calls.map((c) => c[0] as string);
      expect(writeKeys.some((k) => k.toLowerCase().includes("zen"))).toBe(false);
    } finally {
      setItemSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("Z5: a fresh store re-init reads zen back as false regardless of prior mutation", async () => {
    useTreeStore.getState().setZen(true);
    expect(useTreeStore.getState().zen).toBe(true);
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().zen).toBe(false);
  });
});
