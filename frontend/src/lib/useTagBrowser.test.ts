/**
 * `tagsResource` is built with the REAL `createResource` so the resource layer's
 * coalescing/invalidation semantics are exercised for real — only the
 * network-facing `listTags` fetcher is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const listTagsMock = vi.fn();

vi.mock("./tagsApi", async () => {
  const { createResource } = await import("./resources/createResource");
  return {
    tagsResource: createResource("tags", () => listTagsMock(), {
      mode: "cached",
      invalidatedBy: ["tags:updated", "tags:rewritten"],
    }),
    listTagNotes: vi.fn(),
    renameTag: vi.fn(),
    deleteTag: vi.fn(),
  };
});

import { tagsResource } from "./tagsApi";
import { useTagBrowser, __testing__ } from "./useTagBrowser";

const fakeTags = [
  { name: "alpha", count: 3 },
  { name: "beta", count: 1 },
];

describe("useTagBrowser", () => {
  beforeEach(() => {
    listTagsMock.mockReset();
    // Per-entry reset (not the global registry reset) — see useMcpGrants.test.ts
    // for why: it preserves the eventBus subscription createResource() wires
    // up at module-load time, which U3/U4 depend on working across tests.
    tagsResource.clear();
  });

  it("U1: mount triggers listTags fetch; tags populate; loading transitions true -> false", async () => {
    listTagsMock.mockResolvedValue(fakeTags);

    const { result } = renderHook(() => useTagBrowser());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.tags).toEqual(fakeTags);
    expect(result.current.error).toBeNull();
    expect(listTagsMock).toHaveBeenCalledTimes(1);
  });

  it("U2: refresh() triggers a refetch", async () => {
    listTagsMock.mockResolvedValue(fakeTags);

    const { result } = renderHook(() => useTagBrowser());

    await waitFor(() => expect(result.current.loading).toBe(false));

    const newTags = [{ name: "gamma", count: 7 }];
    listTagsMock.mockResolvedValue(newTags);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.tags).toEqual(newTags);
    expect(listTagsMock).toHaveBeenCalledTimes(2);
  });

  it("U3: publishing tags:updated triggers a refetch", async () => {
    listTagsMock.mockResolvedValue(fakeTags);

    const { result } = renderHook(() => useTagBrowser());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const updatedTags = [{ name: "alpha", count: 5 }];
    listTagsMock.mockResolvedValue(updatedTags);

    act(() => {
      __testing__.simulateEvent("tags:updated");
    });

    await waitFor(() => {
      expect(result.current.tags).toEqual(updatedTags);
    });

    expect(listTagsMock).toHaveBeenCalledTimes(2);
  });

  it("U4: publishing tags:rewritten triggers a refetch", async () => {
    listTagsMock.mockResolvedValue(fakeTags);

    const { result } = renderHook(() => useTagBrowser());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const updatedTags = [{ name: "beta", count: 2 }];
    listTagsMock.mockResolvedValue(updatedTags);

    act(() => {
      __testing__.simulateEvent("tags:rewritten");
    });

    await waitFor(() => {
      expect(result.current.tags).toEqual(updatedTags);
    });

    expect(listTagsMock).toHaveBeenCalledTimes(2);
  });

  it("U5: a fetch resolving after unmount does not throw; pre-unmount snapshot is unaffected", async () => {
    let resolvePromise!: (value: typeof fakeTags) => void;
    listTagsMock.mockReturnValue(
      new Promise<typeof fakeTags>((res) => {
        resolvePromise = res;
      }),
    );

    const { result, unmount } = renderHook(() => useTagBrowser());
    expect(result.current.loading).toBe(true);

    unmount();

    expect(() => {
      act(() => {
        resolvePromise(fakeTags);
      });
    }).not.toThrow();

    // result.current is frozen at the last render before unmount — React
    // stops re-rendering an unmounted hook, so this reflects the
    // pre-resolution state, not a post-unmount setState.
    expect(result.current.loading).toBe(true);
    expect(result.current.tags).toEqual([]);
  });

  it("U6: errors surface via error field; loading=false; previous tags preserved", async () => {
    listTagsMock.mockResolvedValue(fakeTags);

    const { result } = renderHook(() => useTagBrowser());
    await waitFor(() => expect(result.current.loading).toBe(false));

    listTagsMock.mockRejectedValue(new Error("network error"));

    // refresh() deliberately does NOT swallow — unlike grants, useTagBrowser
    // surfaces its error — so the test catches the rejection itself while
    // asserting on the resulting snapshot.
    await act(async () => {
      await result.current.refresh().catch(() => undefined);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("network error");
    expect(result.current.loading).toBe(false);
    expect(result.current.tags).toEqual(fakeTags);
  });

  it("U7: two mounted consumers (split-pane shape) produce exactly 1 fetcher call", async () => {
    listTagsMock.mockResolvedValue(fakeTags);

    const { result: r1 } = renderHook(() => useTagBrowser());
    const { result: r2 } = renderHook(() => useTagBrowser());

    await waitFor(() => {
      expect(r1.current.tags).toEqual(fakeTags);
      expect(r2.current.tags).toEqual(fakeTags);
    });

    expect(listTagsMock).toHaveBeenCalledTimes(1);
  });
});
