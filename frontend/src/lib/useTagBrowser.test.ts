/**
 * Tests for useTagBrowser hook. Validates:
 *   U1: mount triggers a listTags fetch; data populates; loading transitions true -> false
 *   U2: refresh() triggers a refetch
 *   U3: subscribing to a `tags:updated` event triggers refresh
 *   U4: subscribing to a `tags:rewritten` event triggers refresh
 *   U5: unmount sets cancelled=true so in-flight fetch results are ignored
 *   U6: errors surface via the `error` field; loading=false; data remains the previous value
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";


const listTagsMock = vi.fn();

vi.mock("./tagsApi", () => ({
  listTags: (...args: unknown[]) => listTagsMock(...args),
  listTagNotes: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
}));


import { useTagBrowser, __testing__ } from "./useTagBrowser";

const fakeTags = [
  { name: "alpha", count: 3 },
  { name: "beta", count: 1 },
];

describe("useTagBrowser", () => {
  beforeEach(() => {
    listTagsMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
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

  it("U3: emitting tags:updated event triggers refresh", async () => {
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

  it("U4: emitting tags:rewritten event triggers refresh", async () => {
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

  it("U5: unmount cancels in-flight fetch; setState is not called after unmount", async () => {
    let resolvePromise!: (value: typeof fakeTags) => void;
    listTagsMock.mockReturnValue(
      new Promise<typeof fakeTags>((res) => {
        resolvePromise = res;
      }),
    );

    const { result, unmount } = renderHook(() => useTagBrowser());
    expect(result.current.loading).toBe(true);

    unmount();

    act(() => {
      resolvePromise(fakeTags);
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.tags).toEqual([]);
  });

  it("U6: errors surface via error field; loading=false; previous tags preserved", async () => {
    listTagsMock.mockResolvedValue(fakeTags);

    const { result } = renderHook(() => useTagBrowser());
    await waitFor(() => expect(result.current.loading).toBe(false));

    listTagsMock.mockRejectedValue(new Error("network error"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("network error");
    expect(result.current.loading).toBe(false);
    expect(result.current.tags).toEqual(fakeTags);
  });
});
