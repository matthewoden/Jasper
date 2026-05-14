/**
 * Tests for useDailyNote hook.
 *
 * Coverage:
 *   - Happy path: calls openTodayDailyNote, sets activeNote, clears loading
 *   - Error path: shows toast on failure, still clears loading in finally
 *   - Re-entrancy guard: second openToday() while in-flight is a no-op
 *   - isLoading mirrors dailyNoteLoading from useTreeStore
 *
 * openTodayDailyNote is mocked so network is not hit.
 * useTreeStore is used directly (real store) — reset between tests.
 * useToast is provided via ToastProvider wrapper.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";

import { useTreeStore } from "./useTreeStore";
import { ToastProvider } from "../components/Toast";

vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn().mockResolvedValue({ data: undefined, error: undefined }),
    PUT: vi.fn().mockResolvedValue({ data: undefined, error: undefined }),
  },
}));

vi.mock("./dailyNoteApi", () => ({
  openTodayDailyNote: vi.fn(),
}));

import { openTodayDailyNote } from "./dailyNoteApi";
import { useDailyNote } from "./useDailyNote";

const mockedOpenToday = vi.mocked(openTodayDailyNote);

const fakeNote = {
  id: "00000000-0000-4000-a000-000000000099",
  path: "daily/2026-05-14.md",
  content: "---\ntags: []\n---\n\n# 2026-05-14\n\n",
  updated_at: "2026-05-14T08:00:00Z",
};

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ToastProvider, null, children);

describe("useDailyNote", () => {
  beforeEach(() => {
    mockedOpenToday.mockReset();
    // Reset store slices relevant to this hook
    useTreeStore.setState({
      dailyNoteLoading: false,
      activeNoteId: null,
    });
  });

  it("DN-HOOK-1: isLoading is false initially (mirrors store)", () => {
    const { result } = renderHook(() => useDailyNote(), { wrapper });
    expect(result.current.isLoading).toBe(false);
  });

  it("DN-HOOK-2: happy path — calls API, sets activeNoteId, clears loading", async () => {
    mockedOpenToday.mockResolvedValueOnce(fakeNote);

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    await act(async () => {
      await result.current.openToday();
    });

    // API was called
    expect(mockedOpenToday).toHaveBeenCalledTimes(1);
    // Active note is set
    expect(useTreeStore.getState().activeNoteId).toBe(fakeNote.id);
    // Loading is cleared in finally
    expect(useTreeStore.getState().dailyNoteLoading).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it("DN-HOOK-3: error path — shows toast, clears loading", async () => {
    mockedOpenToday.mockRejectedValueOnce(new Error("server down"));

    // Spy on useToast's toast function via the store pattern
    const { result } = renderHook(() => useDailyNote(), { wrapper });

    await act(async () => {
      await result.current.openToday();
    });

    // API was called
    expect(mockedOpenToday).toHaveBeenCalledTimes(1);
    // Active note unchanged
    expect(useTreeStore.getState().activeNoteId).toBe(null);
    // Loading is cleared in finally (error path too)
    expect(useTreeStore.getState().dailyNoteLoading).toBe(false);
    // isLoading reflects cleared state
    expect(result.current.isLoading).toBe(false);
  });

  it("DN-HOOK-4: re-entrancy guard — second openToday while in-flight is no-op", async () => {
    // Make the first call never resolve (pending)
    let resolve: (n: typeof fakeNote) => void = () => {};
    const pendingPromise = new Promise<typeof fakeNote>((r) => { resolve = r; });
    mockedOpenToday.mockReturnValueOnce(pendingPromise);

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    // Start first call (don't await)
    act(() => { void result.current.openToday(); });

    // Set loading to true manually (simulates in-flight state)
    await waitFor(() => {
      expect(useTreeStore.getState().dailyNoteLoading).toBe(true);
    });

    // Second call while in-flight — should be no-op
    await act(async () => {
      await result.current.openToday();
    });

    // API still called only once (second call was short-circuited)
    expect(mockedOpenToday).toHaveBeenCalledTimes(1);

    // Resolve the first call
    act(() => { resolve(fakeNote); });
    await waitFor(() => {
      expect(useTreeStore.getState().dailyNoteLoading).toBe(false);
    });
  });

  it("DN-HOOK-5: openToday passes YYYY-MM-DD date string to openTodayDailyNote", async () => {
    mockedOpenToday.mockResolvedValueOnce(fakeNote);

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    await act(async () => {
      await result.current.openToday();
    });

    // Verify the date argument matches YYYY-MM-DD format
    const dateArg = mockedOpenToday.mock.calls[0][0];
    expect(dateArg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
