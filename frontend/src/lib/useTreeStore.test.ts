/**
 * Tests for useTreeStore — Phase 3 zustand store with localStorage
 * persistence (debounced 250ms). Validates the locked store shape, mutators,
 * hydration tolerance for corrupted storage, and the pruneStaleTreeState
 * helper that useFileTree (Plan 03-05 Task 3) calls after every fetch.
 *
 * The persistence side-effects rely on `window`/`localStorage` (jsdom from
 * test-setup.ts provides both). For tests that exercise the module-load
 * hydration path we use vi.resetModules() + vi.isolateModulesAsync to force
 * a fresh import after seeding localStorage.
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
  // Phase 5.5 — Plan 04 (UX-08) / Plan 05 (UX-09) added slices.
  liveLabels: {} as Record<string, string>,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
};

describe("useTreeStore — default + mutators", () => {
  beforeEach(() => {
    // Reset store to defaults between tests; localStorage is cleared too.
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
    // Just re-importing must not throw — and state defaults to empty.
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

    // Inside the debounce window — no writes yet.
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
    // Object identity for `expanded` should be preserved if nothing changed.
    expect(after.expanded).toBe(before.expanded);
    expect(after.activeNoteId).toBe(before.activeNoteId);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Plan 03-20 Gap R2-4 — selectedRow transient slot.
//
// Document-level F2 routing in App.tsx reads useTreeStore.selectedRow at
// fire time to dispatch rename to the most-recently-clicked tree row,
// even when DOM focus has shifted to the editor textarea.
//
// The slot is purely transient — same precedent as pendingRename and
// draftCreate. It MUST NOT be persisted to localStorage and MUST NOT be
// touched by pruneStaleTreeState.
// ──────────────────────────────────────────────────────────────────────────
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
      // Even after the debounce window, no key should have been written
      // for selectedRow. The persistence subscriber only watches
      // expanded + activeNoteId.
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const writes = setItemSpy.mock.calls.map((c) => c[0]);
      // No selectedRow-shaped key.
      expect(
        writes.some(
          (k) =>
            typeof k === "string" &&
            k.toLowerCase().includes("selectedrow"),
        ),
      ).toBe(false);
      // Specifically, neither of the persisted keys was touched as a
      // side-effect of setSelectedRow alone.
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

  // ──────────────────────────────────────────────────────────────────
  // Phase 5.5 — Plan 04 (UX-08): live H1 → tree label slice.
  // Phase 5.5 — Plan 05 (UX-09): sidebar width slice (schema lands here;
  // LS hydration + setter wiring is owned by Plan 05).
  // ──────────────────────────────────────────────────────────────────

  it("UX-08: setLiveLabel adds an entry keyed by note id", () => {
    useTreeStore.getState().setLiveLabel("note-a", "Hello");
    expect(useTreeStore.getState().liveLabels["note-a"]).toBe("Hello");
  });

  it("UX-08: clearLiveLabel removes the entry; absent id is a no-op preserving object identity", () => {
    // Set then clear → entry gone.
    useTreeStore.getState().setLiveLabel("note-a", "Hello");
    expect(useTreeStore.getState().liveLabels["note-a"]).toBe("Hello");
    useTreeStore.getState().clearLiveLabel("note-a");
    expect(useTreeStore.getState().liveLabels["note-a"]).toBeUndefined();

    // Absent id → no-op; the liveLabels reference must NOT change so
    // memoized selectors don't re-render. Capture the full state object
    // before and assert reference identity afterwards.
    const stateBefore = useTreeStore.getState();
    const labelsBefore = stateBefore.liveLabels;
    useTreeStore.getState().clearLiveLabel("definitely-not-here");
    const stateAfter = useTreeStore.getState();
    expect(stateAfter.liveLabels).toBe(labelsBefore);
    // The whole state object identity is also preserved — no setState
    // fired (the mutator returns `s` unchanged).
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
    // Below MIN clamps up to default.
    setSidebarWidth(100);
    expect(useTreeStore.getState().sidebarWidth).toBe(260);
    // Above MIN passes through unchanged.
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
    // Even when the prune ALSO drops a stale active note, selectedRow
    // is left alone — it's a transient slot driven by row clicks.
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

// ──────────────────────────────────────────────────────────────────────────
// Phase 5.5 — Plan 05 (UX-09) — sidebarWidth LS hydration + debounced write.
//
// Hydration tests use `vi.resetModules()` + dynamic import so the module-load
// `if (typeof window !== "undefined")` block runs against a freshly-seeded
// localStorage (matching the existing pattern for `expanded` and
// `activeNoteId` hydration). Debounced-write tests use `vi.useFakeTimers()`.
// ──────────────────────────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────────────────────
  // BL-03 (Phase 5.5 gap-closure Plan 11) — hydration must clamp persisted
  // width against the LIVE viewport's editor-floor headroom. A wide-monitor
  // session that saved 1200px must NOT load at 1200px on a narrow laptop
  // window; it should be clamped to `innerWidth - EDITOR_MIN`.
  //
  // The pattern mirrors the existing hydration tests above: stub
  // localStorage + window.innerWidth, then `vi.resetModules()` + dynamic
  // import to force the module-load `if (typeof window !== "undefined")`
  // hydration block to re-run against the freshly-seeded environment.
  // ────────────────────────────────────────────────────────────────────
  it("BL-03: hydration clamps wide-monitor 1200px persisted width against narrow 900px viewport", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 900,
    });
    localStorage.setItem(LS_KEY_SIDEBAR_WIDTH, JSON.stringify(1200));
    vi.resetModules();
    const mod = await import("./useTreeStore");
    // Live max = 900 - 320 = 580. The persisted 1200 is clamped down to
    // 580 because the editor pane can't go below 320 on a 900px window.
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
    // Live max = 1600 - 320 = 1280. 1200 fits — load at 1200.
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
    // Live max = max(0, 400 - 320) = 80. Sidebar shrinks below MIN to
    // preserve the editor floor; matches SidebarResizeHandle.computeMaxWidth.
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
    // 200 < SIDEBAR_WIDTH_DEFAULT (260); first clamp UP to 260, then
    // min(260, 1024 - 320 = 704) = 260. Existing UX-09 A8 rule preserved.
    expect(mod.useTreeStore.getState().sidebarWidth).toBe(260);
  });

  it("BL-03: no localStorage entry → store stays at SIDEBAR_WIDTH_DEFAULT (no hydration ran)", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
    // No setItem.
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("UX-09: setSidebarWidth triggers debounced LS write", () => {
    localStorage.clear();
    vi.useFakeTimers();
    try {
      // Reset width on the live store so the subscriber's `lastWidth`
      // tracker sees the change deterministically.
      act(() => {
        useTreeStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
      });
      // Drain the post-reset 250ms persistence tick so the spy below only
      // sees the write produced by the explicit setSidebarWidth(380) call.
      act(() => {
        vi.advanceTimersByTime(260);
      });

      const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
      try {
        act(() => {
          useTreeStore.getState().setSidebarWidth(380);
        });
        // Inside the debounce window — no write yet for this key.
        const writesBeforeFlush = setItemSpy.mock.calls.filter(
          (c) => c[0] === LS_KEY_SIDEBAR_WIDTH,
        ).length;
        expect(writesBeforeFlush).toBe(0);
        // Flush the debounce.
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

// ──────────────────────────────────────────────────────────────────────────
// Phase 6 — Plan 06-07: useTreeStore ADD-only extension.
//
// Tests for the four new slices: tagBrowserExpanded, activeTagFilter,
// backlinksRailExpanded, backlinksRailWidth. Uses the same module-reset
// pattern as the existing hydration tests above.
// ──────────────────────────────────────────────────────────────────────────
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

  // S1: Defaults
  it("S1: fresh store returns tagBrowserExpanded=false, activeTagFilter=null, backlinksRailExpanded=false, backlinksRailWidth=280", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    expect(s.tagBrowserExpanded).toBe(false);
    expect(s.activeTagFilter).toBeNull();
    expect(s.backlinksRailExpanded).toBe(false);
    expect(s.backlinksRailWidth).toBe(280);
  });

  // S2: Setters
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

  // S3: Clamp
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

  // S4: LS hydration on load — width
  it("S4: pre-seeded backlinksRailWidth in LS hydrates on module load", async () => {
    localStorage.setItem("jasper.backlinks.rail.width", "350");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().backlinksRailWidth).toBe(350);
  });

  // S5: LS hydration on load — boolean
  it("S5: pre-seeded tagBrowserExpanded=true in LS hydrates on module load", async () => {
    localStorage.setItem("jasper.tag.browser.expanded", "true");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().tagBrowserExpanded).toBe(true);
  });

  // S6: LS hydration — invalid value falls back to default
  it("S6: pre-seeded backlinksRailWidth='garbage' falls back to RAIL_DEFAULT_WIDTH (280)", async () => {
    localStorage.setItem("jasper.backlinks.rail.width", "garbage");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().backlinksRailWidth).toBe(280);
  });

  // S6 also: out-of-range value falls back to default
  it("S6: pre-seeded backlinksRailWidth out of range falls back to RAIL_DEFAULT_WIDTH (280)", async () => {
    localStorage.setItem("jasper.backlinks.rail.width", "50");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().backlinksRailWidth).toBe(280);
  });

  // S7: LS persistence — boolean
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

  // S8: LS persistence — width
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

  // S9: activeTagFilter is NOT persisted
  it("S9: setActiveTagFilter does NOT write to localStorage", () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      act(() => {
        useTreeStore.getState().setActiveTagFilter("foo");
      });
      act(() => { vi.advanceTimersByTime(500); });
      // No LS key should contain "filter" or "tag.filter"
      const allWrites = setItemSpy.mock.calls.map(c => c[0] as string);
      expect(allWrites.some(k => k.includes("filter"))).toBe(false);
    } finally {
      setItemSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("S9: activeTagFilter stays null on fresh module load (not persisted)", async () => {
    // Even if something wrote a filter key, it should not hydrate.
    localStorage.setItem("jasper.tag.filter", "somefilter");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().activeTagFilter).toBeNull();
  });

  // S10: Existing slices unchanged
  it("S10: existing slices still work correctly after Phase 6 additions (regression guard)", () => {
    const { result } = renderHook(() => useTreeStore());
    act(() => {
      result.current.toggleExpanded("projects");
      result.current.setActiveNote("uuid-foo");
      result.current.startRename("note", "uuid-bar");
      result.current.setSelectedRow({ kind: "note", target: "uuid-zzz" });
      // Also set Phase 6 slices to ensure coexistence
      result.current.setTagBrowserExpanded(true);
      result.current.setActiveTagFilter("my-tag");
      result.current.setBacklinksRailExpanded(true);
      result.current.setBacklinksRailWidth(320);
    });
    const s = result.current;
    // Existing slices
    expect(s.expanded.has("projects")).toBe(true);
    expect(s.activeNoteId).toBe("uuid-foo");
    expect(s.pendingRename).toEqual({ kind: "note", target: "uuid-bar" });
    expect(s.selectedRow).toEqual({ kind: "note", target: "uuid-zzz" });
    // Phase 6 slices
    expect(s.tagBrowserExpanded).toBe(true);
    expect(s.activeTagFilter).toBe("my-tag");
    expect(s.backlinksRailExpanded).toBe(true);
    expect(s.backlinksRailWidth).toBe(320);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Phase 6.5 — Plan 06.5-02: useTreeStore ADD-only extension (UX-T-01).
//
// Tests for the two new slices: tagsPanelHeightRatio, rightRailTagsPanelExpanded.
// Uses the same module-reset pattern as the existing hydration tests above.
// ──────────────────────────────────────────────────────────────────────────
describe("Phase 6.5 — tagsPanelHeightRatio + rightRailTagsPanelExpanded", () => {
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

  // T1: Defaults
  it("T1: fresh store returns tagsPanelHeightRatio=0.5, rightRailTagsPanelExpanded=true", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    expect(s.tagsPanelHeightRatio).toBe(0.5);
    expect(s.rightRailTagsPanelExpanded).toBe(true);
  });

  // T2: Setters
  it("T2: setTagsPanelHeightRatio(0.65) stores 0.65 (within bounds)", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    mod.useTreeStore.getState().setTagsPanelHeightRatio(0.65);
    expect(mod.useTreeStore.getState().tagsPanelHeightRatio).toBe(0.65);
  });

  it("T2: setRightRailTagsPanelExpanded(false) flips to false", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    mod.useTreeStore.getState().setRightRailTagsPanelExpanded(false);
    expect(mod.useTreeStore.getState().rightRailTagsPanelExpanded).toBe(false);
  });

  // T3: Clamp
  it("T3: setTagsPanelHeightRatio(0.1) clamps up to TAGS_PANEL_RATIO_MIN (0.2)", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    mod.useTreeStore.getState().setTagsPanelHeightRatio(0.1);
    expect(mod.useTreeStore.getState().tagsPanelHeightRatio).toBe(mod.TAGS_PANEL_RATIO_MIN);
    expect(mod.useTreeStore.getState().tagsPanelHeightRatio).toBe(0.2);
  });

  it("T3: setTagsPanelHeightRatio(0.95) clamps down to TAGS_PANEL_RATIO_MAX (0.8)", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    mod.useTreeStore.getState().setTagsPanelHeightRatio(0.95);
    expect(mod.useTreeStore.getState().tagsPanelHeightRatio).toBe(mod.TAGS_PANEL_RATIO_MAX);
    expect(mod.useTreeStore.getState().tagsPanelHeightRatio).toBe(0.8);
  });

  // T4: LS hydration — ratio
  it("T4: pre-seeded tagsPanelHeightRatio=0.7 in LS hydrates on module load", async () => {
    localStorage.setItem("jasper.rail.tags.height.ratio", "0.7");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().tagsPanelHeightRatio).toBe(0.7);
  });

  it("T4: pre-seeded tagsPanelHeightRatio=1.5 (out of range) falls back to default 0.5", async () => {
    localStorage.setItem("jasper.rail.tags.height.ratio", "1.5");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().tagsPanelHeightRatio).toBe(0.5);
  });

  it("T4: pre-seeded tagsPanelHeightRatio='not-a-number' falls back to default 0.5", async () => {
    localStorage.setItem("jasper.rail.tags.height.ratio", "not-a-number");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().tagsPanelHeightRatio).toBe(0.5);
  });

  // T5: LS hydration — boolean
  it("T5: pre-seeded rightRailTagsPanelExpanded=false in LS hydrates on module load", async () => {
    localStorage.setItem("jasper.rail.tags.expanded", "false");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().rightRailTagsPanelExpanded).toBe(false);
  });

  it("T5: absent LS key → rightRailTagsPanelExpanded stays true (default)", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().rightRailTagsPanelExpanded).toBe(true);
  });

  // T6: LS persistence — ratio (debounced 250ms)
  it("T6: setTagsPanelHeightRatio(0.7) persists to LS after 250ms debounce", () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      act(() => {
        useTreeStore.getState().setTagsPanelHeightRatio(0.7);
      });
      // Inside debounce window — no write yet
      const writesBeforeFlush = setItemSpy.mock.calls.filter(
        (c) => c[0] === "jasper.rail.tags.height.ratio",
      ).length;
      expect(writesBeforeFlush).toBe(0);
      act(() => { vi.advanceTimersByTime(300); });
      const writes = setItemSpy.mock.calls.filter(
        (c) => c[0] === "jasper.rail.tags.height.ratio",
      );
      expect(writes.length).toBeGreaterThan(0);
      expect(writes[writes.length - 1][1]).toBe("0.7");
    } finally {
      setItemSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  // T7: LS persistence — boolean (immediate)
  it("T7: setRightRailTagsPanelExpanded(false) immediately writes to LS (no debounce)", () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    try {
      act(() => {
        useTreeStore.getState().setRightRailTagsPanelExpanded(false);
      });
      const writes = setItemSpy.mock.calls.filter(
        (c) => c[0] === "jasper.rail.tags.expanded",
      );
      expect(writes.length).toBeGreaterThan(0);
      expect(writes[writes.length - 1][1]).toBe("false");
    } finally {
      setItemSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  // T8: LS key constants
  it("T8: LS key constants have expected literal string values", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.LS_KEY_TAGS_PANEL_HEIGHT_RATIO).toBe("jasper.rail.tags.height.ratio");
    expect(mod.LS_KEY_TAGS_PANEL_EXPANDED).toBe("jasper.rail.tags.expanded");
  });

  // T9: Existing Phase 6 slices unchanged
  it("T9: existing Phase 6 slices work alongside Phase 6.5 additions (regression guard)", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    // Phase 6 defaults still correct
    expect(s.tagBrowserExpanded).toBe(false);
    expect(s.activeTagFilter).toBeNull();
    expect(s.backlinksRailExpanded).toBe(false);
    expect(s.backlinksRailWidth).toBe(280);
    // Phase 6.5 defaults also correct
    expect(s.tagsPanelHeightRatio).toBe(0.5);
    expect(s.rightRailTagsPanelExpanded).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Phase 6.6 — Plan 06.6-02: useTreeStore ADD-only chrome slices (D-29).
//
// Tests for three new slices: notesSidebarVisible, panelSelector.tags,
// panelSelector.backlinks. Uses the same module-reset hydration pattern
// as existing hydration tests.
// ──────────────────────────────────────────────────────────────────────────
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

  // C1: Initial state — all three default to true when LS empty
  it("C1: fresh store returns notesSidebarVisible=true, panelSelector={tags:true, backlinks:true}", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    expect(s.notesSidebarVisible).toBe(true);
    expect(s.panelSelector.tags).toBe(true);
    expect(s.panelSelector.backlinks).toBe(true);
  });

  // C2: setNotesSidebarVisible flips the slice
  it("C2: setNotesSidebarVisible(false) flips the slice; setNotesSidebarVisible(true) restores it", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    mod.useTreeStore.getState().setNotesSidebarVisible(false);
    expect(mod.useTreeStore.getState().notesSidebarVisible).toBe(false);
    mod.useTreeStore.getState().setNotesSidebarVisible(true);
    expect(mod.useTreeStore.getState().notesSidebarVisible).toBe(true);
  });

  // C3: Partial setter — setPanelSelector({tags:false}) leaves backlinks unchanged
  it("C3: setPanelSelector({tags:false}) sets tags=false, leaves backlinks=true", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    mod.useTreeStore.getState().setPanelSelector({ tags: false });
    const s = mod.useTreeStore.getState();
    expect(s.panelSelector.tags).toBe(false);
    expect(s.panelSelector.backlinks).toBe(true);
  });

  // C3 also: updating both keys at once
  it("C3: setPanelSelector({tags:false, backlinks:false}) updates both keys", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    mod.useTreeStore.getState().setPanelSelector({ tags: false, backlinks: false });
    const s = mod.useTreeStore.getState();
    expect(s.panelSelector.tags).toBe(false);
    expect(s.panelSelector.backlinks).toBe(false);
  });

  // C4: LS persistence — after setNotesSidebarVisible(false), LS key = "false"
  it("C4: setNotesSidebarVisible(false) immediately writes 'false' to LS_KEY_SIDEBAR_VISIBLE", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    vi.useRealTimers(); // no debounce — persistence is immediate for chrome slices
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

  // C5: LS hydration — pre-setting "false" before module load yields notesSidebarVisible=false
  it("C5: pre-seeded LS_KEY_SIDEBAR_VISIBLE='false' yields notesSidebarVisible=false on load", async () => {
    // Seed BEFORE module import (vi.resetModules was called in afterEach)
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

  it("C5: pre-seeded LS_KEY_PANEL_TAGS='false' yields panelSelector.tags=false on load", async () => {
    localStorage.setItem("jasper.chrome.panel.selector.tags", "false");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().panelSelector.tags).toBe(false);
    expect(mod.useTreeStore.getState().panelSelector.backlinks).toBe(true);
  });

  it("C5: pre-seeded LS_KEY_PANEL_BACKLINKS='false' yields panelSelector.backlinks=false on load", async () => {
    localStorage.setItem("jasper.chrome.panel.selector.backlinks", "false");
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.useTreeStore.getState().panelSelector.backlinks).toBe(false);
    expect(mod.useTreeStore.getState().panelSelector.tags).toBe(true);
  });

  // C6: ADD-ONLY invariant — Phase 6.5 slices still exist with their defaults
  it("C6: ADD-ONLY — Phase 6.5 slices (tagsPanelHeightRatio, rightRailTagsPanelExpanded, backlinksRailExpanded) unchanged", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    const s = mod.useTreeStore.getState();
    expect(s.tagsPanelHeightRatio).toBe(0.5);
    expect(s.rightRailTagsPanelExpanded).toBe(true);
    expect(s.backlinksRailExpanded).toBe(false);
  });

  // LS key constants
  it("C7: LS key constants have expected literal string values", async () => {
    vi.resetModules();
    const mod = await import("./useTreeStore");
    expect(mod.LS_KEY_SIDEBAR_VISIBLE).toBe("jasper.chrome.sidebar.visible");
    expect(mod.LS_KEY_PANEL_TAGS).toBe("jasper.chrome.panel.selector.tags");
    expect(mod.LS_KEY_PANEL_BACKLINKS).toBe("jasper.chrome.panel.selector.backlinks");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// WR-07 (Phase 5.5 gap-closure Plan 13) — pruneStaleTreeState liveLabels rebuild.
//
// The original implementation cloned `liveLabels` lazily and then `delete`d
// keys via a `Record<string, string>` cast — the cast defeats TypeScript
// narrowing on the liveLabels shape. The rebuild pattern replaces the
// cloned-and-deleted object with `Object.fromEntries(...)` over the kept
// entries, which is non-mutating and keeps the derived type aligned with
// the source `liveLabels` type.
//
// Behavior contract (does NOT change):
//   - Stale id removal still drops the bad keys.
//   - No-op pass (every id is still present) preserves liveLabels reference
//     identity so memoized consumers don't re-render.
// ──────────────────────────────────────────────────────────────────────────
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
