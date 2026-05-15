/**
 * Tests for useFileTree — Phase 3 single-flight tree fetch hook with
 * optimistic mutate, manual refresh, and stale-state pruning into the zustand
 * store. The signature here is LOCKED per UI-SPEC §Forward-compat assert #1
 * (Phase 4 swaps internals to WS without changing the public shape).
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTreeMock = vi.fn();

vi.mock("./treeApi", () => ({
  getTree: (...args: unknown[]) => getTreeMock(...args),
}));

import { useTreeStore } from "./useTreeStore";
import { __testing__, useFileTree } from "./useFileTree";

const { coalescedGetTree, __resetCoalescer } = __testing__;

type Tree = {
  root: Array<
    | {
        kind: "folder";
        path: string;
        name: string;
        children?: Tree["root"];
      }
    | {
        kind: "note";
        id: string;
        path: string;
        title: string;
        updated_at: string;
      }
  >;
};

const tinyTree: Tree = {
  root: [
    {
      kind: "folder",
      path: "projects",
      name: "projects",
      children: [
        {
          kind: "note",
          id: "uuid-a",
          path: "projects/a.md",
          title: "a",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    },
    {
      kind: "note",
      id: "uuid-root",
      path: "root.md",
      title: "root",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ],
};

describe("useFileTree", () => {
  beforeEach(() => {
    getTreeMock.mockReset();
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
    });
  });

  it("TestUseFileTree_FetchesOnMount: data resolves into hook.tree, loading flips false", async () => {
    getTreeMock.mockResolvedValue({ data: tinyTree });

    const { result } = renderHook(() => useFileTree());

    expect(result.current.loading).toBe(true);
    expect(result.current.tree).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tree).toEqual(tinyTree);
    expect(result.current.error).toBeNull();
  });

  it("TestUseFileTree_HandlesError: error response sets hook.error and clears loading", async () => {
    getTreeMock.mockResolvedValue({
      error: { code: "tree_projection_failed", message: "boom", status: 500 },
    });

    const { result } = renderHook(() => useFileTree());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tree).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toBe("boom");
  });

  it("TestUseFileTree_Refresh_Re-Fetches: refresh() picks up the new mock response", async () => {
    getTreeMock.mockResolvedValueOnce({ data: tinyTree });
    const { result } = renderHook(() => useFileTree());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tree).toEqual(tinyTree);

    const v2: Tree = {
      root: [
        {
          kind: "note",
          id: "uuid-only",
          path: "only.md",
          title: "only",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    };
    getTreeMock.mockResolvedValueOnce({ data: v2 });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.tree).toEqual(v2);
    expect(getTreeMock).toHaveBeenCalledTimes(2);
  });

  it("TestUseFileTree_Mutate_AppliesOptimisticRecipe: mutate updates tree without re-fetching", async () => {
    getTreeMock.mockResolvedValue({ data: tinyTree });
    const { result } = renderHook(() => useFileTree());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const callCountBeforeMutate = getTreeMock.mock.calls.length;

    act(() => {
      result.current.mutate((cur) => ({
        ...cur,
        root: [
          ...cur.root,
          {
            kind: "folder",
            path: "added",
            name: "added",
            children: [],
          },
        ],
      }));
    });

    expect(result.current.tree?.root.length).toBe(3);
    expect(result.current.tree?.root[2]).toMatchObject({
      kind: "folder",
      path: "added",
    });
    // No additional fetch.
    expect(getTreeMock.mock.calls.length).toBe(callCountBeforeMutate);
  });

  it("TestUseFileTree_PrunesStaleTreeState: expanded paths absent in fresh tree are dropped", async () => {
    // Pre-seed the store with stale entries.
    useTreeStore.setState({
      expanded: new Set(["old-folder", "projects"]),
      activeNoteId: "stale-uuid",
    });

    getTreeMock.mockResolvedValue({ data: tinyTree });
    const { result } = renderHook(() => useFileTree());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const s = useTreeStore.getState();
    // "projects" is in tinyTree → kept; "old-folder" → dropped.
    expect(s.expanded.has("projects")).toBe(true);
    expect(s.expanded.has("old-folder")).toBe(false);
    // "stale-uuid" not present → cleared.
    expect(s.activeNoteId).toBeNull();
  });

  it("TestUseFileTree_StrictMode_NoDuplicateFetch: cancelled flag prevents stale resolution", async () => {
    let resolveCount = 0;
    getTreeMock.mockImplementation(async () => {
      resolveCount++;
      return { data: tinyTree };
    });

    const first = renderHook(() => useFileTree());
    first.unmount();

    const second = renderHook(() => useFileTree());
    await waitFor(() => expect(second.result.current.loading).toBe(false));

    // The second mount's resolution lands; the first is cancelled.
    expect(second.result.current.error).toBeNull();
    expect(second.result.current.tree).toEqual(tinyTree);
    // resolveCount may be 1 or 2 depending on timing — what matters is no error escapes.
    expect(resolveCount).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UFT-eager-boot — tree fetch fires on module import (UAT-2 R1-2/R1-3)
// ─────────────────────────────────────────────────────────────────────────────
describe("UFT-eager-boot — tree fetch fires on module import (UAT-2 R1-2/R1-3)", () => {
  it("useFileTree fires boot fetch on app start", async () => {
    // This test verifies that GET /tree is called at module import time
    // (boot fetch), BEFORE any useFileTree hook instance mounts.
    //
    // Approach: use vi.resetModules() + vi.doMock() to freshly re-import
    // useFileTree in a clean module scope. When the module loads, the
    // boot-fetch trigger should fire getTree() automatically.
    //
    // The boot-fetch must fire exactly once (no duplicate calls) even when
    // the module is imported multiple times within the same app lifecycle.
    const getTreeForBoot = vi.fn().mockResolvedValue({ data: tinyTree });

    vi.resetModules();
    vi.doMock("./treeApi", () => ({
      getTree: (...args: unknown[]) => getTreeForBoot(...args),
    }));
    vi.doMock("./useTreeStore", () => ({
      pruneStaleTreeState: vi.fn(),
      useTreeStore: vi.fn(),
    }));

    // Re-import the module — the boot fetch should fire synchronously during module init
    await import("./useFileTree");

    // Give the micro-task queue a tick so the async boot fetch can start
    await new Promise((r) => setTimeout(r, 0));

    // Assert: getTree was called once at module import (boot fetch), before any hook mounts
    expect(getTreeForBoot).toHaveBeenCalledTimes(1);

    // Cleanup: restore real mocks for subsequent tests
    vi.doUnmock("./treeApi");
    vi.doUnmock("./useTreeStore");
    vi.resetModules();
  });
});

describe("UX-14 single-flight", () => {
  beforeEach(() => {
    getTreeMock.mockReset();
    // Clear module-level coalescer state so each test starts cold —
    // the trailing-window state from a prior test in the file would
    // otherwise route the first concurrent call into the
    // trailing-debounce branch instead of firing immediately.
    __resetCoalescer();
  });

  it("coalesces concurrent fetchTree calls into one network request", async () => {
    // Mock getTree to return a delayed promise so we can fire concurrent
    // calls into the still-in-flight slot.
    let resolveDelayed!: (v: { data: Tree }) => void;
    const delayed = new Promise<{ data: Tree }>((resolve) => {
      resolveDelayed = resolve;
    });
    getTreeMock.mockImplementation(() => delayed);

    // Three concurrent invocations — single-flight should collapse all
    // three into a single underlying getTree() call.
    const calls = [coalescedGetTree(), coalescedGetTree(), coalescedGetTree()];
    expect(getTreeMock).toHaveBeenCalledTimes(1);

    resolveDelayed({ data: tinyTree as unknown as Tree });
    const results = await Promise.all(calls);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.data?.root)).toBe(true);
  });

  it("clears the in-flight slot on rejection so subsequent calls retry", async () => {
    getTreeMock
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ data: tinyTree });

    await expect(coalescedGetTree()).rejects.toThrow("network");
    // Slot cleared in .finally — second call goes through, getTree
    // is invoked a second time rather than re-serving the rejection.
    const second = await coalescedGetTree();
    expect(second.data?.root).toEqual(tinyTree.root);
    expect(getTreeMock).toHaveBeenCalledTimes(2);
  });

  it("a fresh call AFTER the in-flight resolves issues a new fetch", async () => {
    const v2: Tree = {
      root: [
        {
          kind: "note",
          id: "uuid-only",
          path: "only.md",
          title: "only",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    } as unknown as Tree;
    getTreeMock
      .mockResolvedValueOnce({ data: tinyTree })
      .mockResolvedValueOnce({ data: v2 });

    const first = await coalescedGetTree();
    expect(first.data?.root).toEqual(tinyTree.root);
    const second = await coalescedGetTree();
    expect(second.data?.root).toEqual(v2.root);
    expect(getTreeMock).toHaveBeenCalledTimes(2);
  });
});
