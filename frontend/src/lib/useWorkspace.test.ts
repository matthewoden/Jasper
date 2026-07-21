/**
 * Tests for useWorkspace hook — rightPanel slice (TAGS-01).
 * Covers optimistic setRightPanel mutate, revert-and-toast on failure, and
 * hydration from a fetched workspace doc on refresh(). Mirrors
 * useBookmarks.test.ts's mock-module + renderHook shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";

const getWorkspaceMock = vi.fn();
const putWorkspaceMock = vi.fn();

vi.mock("./workspaceApi", () => ({
  getWorkspace: (...args: unknown[]) => getWorkspaceMock(...args),
  putWorkspace: (...args: unknown[]) => putWorkspaceMock(...args),
}));

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
} from "./useTreeStore";
import { useWorkspace } from "./useWorkspace";

const wrapper = ({ children }: { children: ReactNode }) => children;

describe("useWorkspace — rightPanel", () => {
  beforeEach(() => {
    getWorkspaceMock.mockReset();
    putWorkspaceMock.mockReset();
    toastSpy.mockReset();
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

  it("W3: refresh() hydrates rightPanel from a fetched workspace doc", async () => {
    getWorkspaceMock.mockResolvedValue({ rightPanel: "backlinks" });

    renderHook(() => useWorkspace(), { wrapper });

    await waitFor(() => {
      expect(useTreeStore.getState().rightPanel).toBe("backlinks");
    });
  });

  it("W4: refresh() falls back to the default when rightPanel is empty/absent", async () => {
    getWorkspaceMock.mockResolvedValue({ rightPanel: "" });

    renderHook(() => useWorkspace(), { wrapper });

    await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledTimes(1));
    expect(useTreeStore.getState().rightPanel).toBe(RIGHT_PANEL_DEFAULT);
  });
});
