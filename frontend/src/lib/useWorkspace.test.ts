/**
 * Tests for useWorkspace hook — rightPanel slice (TAGS-01).
 * Covers optimistic setRightPanel mutate, revert-and-toast on failure, and
 * hydration from the shared workspace cache on mount. Mirrors
 * useBookmarks.test.ts's mock-module + renderHook shape.
 *
 * `workspaceResource` is built with the REAL `createResource` (not mocked)
 * so the resource layer's coalescing/invalidation semantics are exercised
 * for real — only the network-facing `getWorkspace`/`putWorkspace`
 * fetchers are mocked via `./workspaceApi`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";

const getWorkspaceMock = vi.fn();
const putWorkspaceMock = vi.fn();

vi.mock("./workspaceApi", async () => {
  const { createResource } = await import("./resources/createResource");
  return {
    workspaceResource: createResource(
      "workspace",
      () => getWorkspaceMock(),
      { mode: "cached", invalidatedBy: ["workspace:changed"] },
    ),
    putWorkspace: (...args: unknown[]) => putWorkspaceMock(...args),
  };
});

const toastSpy = vi.fn();
vi.mock("../components/toast.utils", () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));

import {
  useTreeStore,
  NOTES_SORT_DEFAULT,
  SEARCH_SORT_DEFAULT,
  RIGHT_PANEL_DEFAULT,
  BOOKMARKS_SORT_DEFAULT,
} from "./useTreeStore";
import { workspaceResource } from "./workspaceApi";
import { useWorkspace } from "./useWorkspace";

const wrapper = ({ children }: { children: ReactNode }) => children;

describe("useWorkspace — rightPanel", () => {
  beforeEach(() => {
    getWorkspaceMock.mockReset();
    putWorkspaceMock.mockReset();
    toastSpy.mockReset();
    // Per-entry reset (not the global registry reset): the eventBus
    // subscription createResource() wires up at module-load time inside
    // the mock factory above must survive across tests. clear() resets
    // cached data/hydrated/error without touching that subscription.
    workspaceResource.clear();
    useTreeStore.setState({
      notesSort: NOTES_SORT_DEFAULT,
      searchSort: SEARCH_SORT_DEFAULT,
      rightPanel: RIGHT_PANEL_DEFAULT,
    });
  });

  it("W1: setRightPanel optimistically updates the slice and calls putWorkspace", async () => {
    getWorkspaceMock.mockResolvedValue({});
    putWorkspaceMock.mockResolvedValue({ rightPanel: "tags" });

    const { result } = renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.setRightPanel("tags");
    });

    expect(useTreeStore.getState().rightPanel).toBe("tags");
    expect(putWorkspaceMock).toHaveBeenCalledWith({ rightPanel: "tags" });
  });

  it("W2: setRightPanel reverts the slice and toasts on failure", async () => {
    getWorkspaceMock.mockResolvedValue({});
    putWorkspaceMock.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledTimes(1));

    expect(useTreeStore.getState().rightPanel).toBe("outline");

    await act(async () => {
      await result.current.setRightPanel("tags");
    });

    expect(useTreeStore.getState().rightPanel).toBe("outline");
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't save panel selection. Try again.",
        variant: "error",
      }),
    );
  });

  it("W3: mount hydrates rightPanel from the shared workspace cache", async () => {
    getWorkspaceMock.mockResolvedValue({ rightPanel: "backlinks" });

    renderHook(() => useWorkspace(), { wrapper });

    await waitFor(() => {
      expect(useTreeStore.getState().rightPanel).toBe("backlinks");
    });
  });

  it("W4: mount falls back to the default when rightPanel is empty/absent", async () => {
    getWorkspaceMock.mockResolvedValue({ rightPanel: "" });

    renderHook(() => useWorkspace(), { wrapper });

    await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledTimes(1));
    expect(useTreeStore.getState().rightPanel).toBe(RIGHT_PANEL_DEFAULT);
  });

  it("W5: three mounted consumers produce exactly one fetcher call (fetch-once)", async () => {
    getWorkspaceMock.mockResolvedValue({ rightPanel: "tags" });

    renderHook(() => useWorkspace(), { wrapper });
    renderHook(() => useWorkspace(), { wrapper });
    renderHook(() => useWorkspace(), { wrapper });

    await waitFor(() => {
      expect(useTreeStore.getState().rightPanel).toBe("tags");
    });

    expect(getWorkspaceMock).toHaveBeenCalledTimes(1);
  });

  it("W6: setNotesSort success patches the shared cache so a later refetch doesn't revert the choice", async () => {
    getWorkspaceMock.mockResolvedValueOnce({});
    putWorkspaceMock.mockResolvedValue({ notesSort: "modified-desc" });

    const { result } = renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.setNotesSort("modified-desc");
    });

    expect(workspaceResource.peek().data?.notesSort).toBe("modified-desc");
  });
});

describe("useWorkspace — bookmarksSort", () => {
  beforeEach(() => {
    getWorkspaceMock.mockReset();
    putWorkspaceMock.mockReset();
    toastSpy.mockReset();
    workspaceResource.clear();
    useTreeStore.setState({
      notesSort: NOTES_SORT_DEFAULT,
      searchSort: SEARCH_SORT_DEFAULT,
      rightPanel: RIGHT_PANEL_DEFAULT,
      bookmarksSort: BOOKMARKS_SORT_DEFAULT,
    });
  });

  it("B1: defaults to manual", () => {
    expect(BOOKMARKS_SORT_DEFAULT).toBe("manual");
    expect(useTreeStore.getState().bookmarksSort).toBe("manual");
  });

  it("B2: setBookmarksSort optimistically updates the slice and PUTs exactly once", async () => {
    getWorkspaceMock.mockResolvedValue({});
    putWorkspaceMock.mockResolvedValue({ bookmarksSort: "name-asc" });

    const { result } = renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.setBookmarksSort("name-asc");
    });

    expect(useTreeStore.getState().bookmarksSort).toBe("name-asc");
    expect(putWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(putWorkspaceMock).toHaveBeenCalledWith({ bookmarksSort: "name-asc" });
  });

  it("B3: setBookmarksSort reverts the slice and toasts on failure", async () => {
    getWorkspaceMock.mockResolvedValue({});
    putWorkspaceMock.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.setBookmarksSort("created-desc");
    });

    expect(useTreeStore.getState().bookmarksSort).toBe(BOOKMARKS_SORT_DEFAULT);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't save sort order. Try again.",
        variant: "error",
      }),
    );
  });

  it("B4: mount hydrates bookmarksSort from the shared workspace cache", async () => {
    getWorkspaceMock.mockResolvedValue({ bookmarksSort: "modified-desc" });

    renderHook(() => useWorkspace(), { wrapper });

    await waitFor(() => {
      expect(useTreeStore.getState().bookmarksSort).toBe("modified-desc");
    });
  });

  it("B5: mount falls back to manual when bookmarksSort is empty/absent", async () => {
    getWorkspaceMock.mockResolvedValue({ bookmarksSort: "" });

    renderHook(() => useWorkspace(), { wrapper });

    await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledTimes(1));
    expect(useTreeStore.getState().bookmarksSort).toBe(BOOKMARKS_SORT_DEFAULT);
  });
});
