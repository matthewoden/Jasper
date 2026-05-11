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

// We need to track event handlers registered via useSessionSync-like mechanism.
// The useTagBrowser hook registers handlers via a module-level set or via
// a callback that gets invoked when WS events arrive. We'll mock tagsApi
// and expose a way to simulate WS events.

const listTagsMock = vi.fn();

vi.mock("./tagsApi", () => ({
  listTags: (...args: unknown[]) => listTagsMock(...args),
  listTagNotes: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
}));

// We need to simulate the WS event dispatch. The useTagBrowser hook should
// register a handler for tags:updated and tags:rewritten events. The exact
// mechanism will be determined during implementation — but we need to expose
// a way for tests to trigger the refresh.
// The hook exports a way to register its refresh as a subscriber to tag events.
// For testing, we simulate this by exposing a manual dispatch mechanism.

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

    // Initially loading
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

    // Simulate the WS event via the test helper
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

    // Unmount before the fetch resolves
    unmount();

    // Now resolve the promise — the hook should ignore this since it was unmounted
    act(() => {
      resolvePromise(fakeTags);
    });

    // If the hook didn't guard against unmount, this would cause a React
    // "setState on unmounted component" warning / error. The test passes if
    // no such error is thrown and the hook remains in loading=true state.
    expect(result.current.loading).toBe(true);
    expect(result.current.tags).toEqual([]);
  });

  it("U6: errors surface via error field; loading=false; previous tags preserved", async () => {
    listTagsMock.mockResolvedValue(fakeTags);

    const { result } = renderHook(() => useTagBrowser());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Second fetch fails
    listTagsMock.mockRejectedValue(new Error("network error"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("network error");
    expect(result.current.loading).toBe(false);
    // Previous data is preserved (don't clear on error per useFileTree precedent)
    expect(result.current.tags).toEqual(fakeTags);
  });
});
