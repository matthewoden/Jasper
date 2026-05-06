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
  pruneStaleTreeState,
  useTreeStore,
} from "./useTreeStore";

const FULL_DEFAULT_STATE = {
  expanded: new Set<string>(),
  activeNoteId: null,
  pendingRename: null,
  draftCreate: null,
  selectedRow: null,
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
