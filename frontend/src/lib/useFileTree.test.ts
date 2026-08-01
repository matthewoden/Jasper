/**
 * Tests for useFileTree — the resource-layer-backed tree hook. Drives the
 * REAL treeResource (not mocked) against a mocked client.GET, so the whole
 * pipeline (treeResource -> treeApi's private fetchTree -> pruneStaleTreeState)
 * exercises for real; only the network boundary is faked.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
vi.mock("../api/client", () => ({
  client: { GET: (...args: unknown[]) => getMock(...args) },
}));

import { useTreeStore } from "./useTreeStore";
import { treeResource, type Tree } from "./treeApi";
import { __testing__ as resourcesTesting } from "./resources/createResource";
import { broadcastRefresh, useFileTree } from "./useFileTree";

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

function okResponse(data: unknown) {
  return { data, error: undefined, response: { status: 200 } };
}

describe("useFileTree", () => {
  beforeEach(() => {
    getMock.mockReset();
    // treeResource is a module-level "cached" singleton — reset between
    // tests so each test's mount issues its own fresh fetch instead of
    // reading a previous test's cached value.
    resourcesTesting.reset();
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
    });
  });

  it("TestUseFileTree_FetchesOnMount: data resolves into hook.tree, loading flips false", async () => {
    getMock.mockResolvedValue(okResponse(tinyTree));

    const { result } = renderHook(() => useFileTree());

    expect(result.current.loading).toBe(true);
    expect(result.current.tree).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tree).toEqual(tinyTree);
    expect(result.current.error).toBeNull();
  });

  it("TestUseFileTree_HandlesError: error response sets hook.error and clears loading", async () => {
    getMock.mockResolvedValue({
      data: undefined,
      error: { code: "tree_projection_failed", message: "boom" },
      response: { status: 500 },
    });

    const { result } = renderHook(() => useFileTree());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tree).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toBe("boom");
  });

  it("TestUseFileTree_Refresh_ReFetches: refresh() picks up the new mock response", async () => {
    getMock.mockResolvedValueOnce(okResponse(tinyTree));
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
    getMock.mockResolvedValueOnce(okResponse(v2));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.tree).toEqual(v2);
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("TestUseFileTree_PrunesStaleTreeState: expanded paths absent in fresh tree are dropped", async () => {
    useTreeStore.setState({
      expanded: new Set(["old-folder", "projects"]),
      activeNoteId: "stale-uuid",
    });

    getMock.mockResolvedValue(okResponse(tinyTree));
    const { result } = renderHook(() => useFileTree());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const s = useTreeStore.getState();
    expect(s.expanded.has("projects")).toBe(true);
    expect(s.expanded.has("old-folder")).toBe(false);
    expect(s.activeNoteId).toBeNull();
  });

  it("TestUseFileTree_StrictMode_NoDuplicateFetch: an unmount immediately followed by a remount still resolves the real tree", async () => {
    getMock.mockResolvedValue(okResponse(tinyTree));

    const first = renderHook(() => useFileTree());
    first.unmount();

    const second = renderHook(() => useFileTree());
    await waitFor(() => expect(second.result.current.loading).toBe(false));

    expect(second.result.current.error).toBeNull();
    expect(second.result.current.tree).toEqual(tinyTree);
  });

  it("twelve simultaneous useFileTree() consumers produce exactly one fetcher call", async () => {
    getMock.mockResolvedValue(okResponse(tinyTree));

    const hooks = Array.from({ length: 12 }, () => renderHook(() => useFileTree()));

    await waitFor(() =>
      expect(hooks.every((h) => h.result.current.loading === false)).toBe(true),
    );

    for (const h of hooks) {
      expect(h.result.current.tree).toEqual(tinyTree);
    }
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION opennotefromtree-row-missing: an invalidate() arriving while a read() is in flight must not resolve against that stale (pre-mutation) snapshot", async () => {
    // A mounted subscriber is required, or invalidate() takes the
    // zero-subscriber "mark stale, don't fetch" path instead of actually
    // refetching (see createResource.ts's invalidateEntry).
    let resolveStale!: (v: { data: Tree }) => void;
    const staleFetch = new Promise<{ data: Tree }>((resolve) => {
      resolveStale = resolve;
    });
    const withNewNote: Tree = {
      root: [
        ...tinyTree.root,
        {
          kind: "note",
          id: "uuid-new",
          path: "new.md",
          title: "new",
          updated_at: "2026-01-03T00:00:00Z",
        },
      ],
    };

    getMock
      .mockImplementationOnce(() => staleFetch.then((v) => okResponse(v.data)))
      .mockResolvedValueOnce(okResponse(withNewNote));

    // Mount issues call #1 (still pending — the "already-running fetch,
    // issued before a mutation happened" case).
    const { result } = renderHook(() => useFileTree());
    expect(getMock).toHaveBeenCalledTimes(1);

    // call #2: e.g. the WS `note:created` handler's invalidate, arriving
    // WHILE call #1 is still in flight — this is the exact race from
    // opennotefromtree-row-missing (commit 7494174d), ported onto treeResource.
    const invalidatePromise = act(async () => treeResource.invalidate());

    // call #1's HTTP request was issued before the mutation, so it resolves
    // without the new note.
    resolveStale({ data: tinyTree });

    await invalidatePromise;

    await waitFor(() => expect(result.current.tree).toEqual(withNewNote));
    // call #2 (the invalidation) must NOT have been satisfied by call #1's
    // stale, pre-mutation snapshot — it must reflect a fetch issued after
    // its own call.
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("broadcastRefresh() invalidates the shared cache without mounting a display subscriber", async () => {
    getMock.mockResolvedValue(okResponse(tinyTree));
    const { result } = renderHook(() => useFileTree());
    await waitFor(() => expect(result.current.loading).toBe(false));

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
    getMock.mockResolvedValueOnce(okResponse(v2));

    await act(async () => {
      await broadcastRefresh();
    });

    await waitFor(() => expect(result.current.tree).toEqual(v2));
  });
});
