/**
 * openTodayDailyNote is mocked so the network is not hit. useTreeStore is the real
 * store, reset between tests; useToast comes from a ToastProvider wrapper.
 */
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";

import { useTreeStore } from "./useTreeStore";
import { usePaneStore } from "./usePaneStore";
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


vi.mock("./useFileTree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useFileTree")>();
  return {
    ...actual,
    broadcastRefresh: vi.fn().mockResolvedValue(undefined),
  };
});

import { openTodayDailyNote } from "./dailyNoteApi";
import { broadcastRefresh } from "./useFileTree";
import { useDailyNote } from "./useDailyNote";

const mockedBroadcastRefresh = vi.mocked(broadcastRefresh);

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
    mockedBroadcastRefresh.mockReset();
    mockedBroadcastRefresh.mockResolvedValue(undefined);
    useTreeStore.setState({
      dailyNoteLoading: false,
      activeNoteId: null,
      expanded: new Set(),
    });
    usePaneStore.getState().clearAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

    expect(mockedOpenToday).toHaveBeenCalledTimes(1);
    expect(useTreeStore.getState().activeNoteId).toBe(fakeNote.id);
    expect(useTreeStore.getState().dailyNoteLoading).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it("DN-HOOK-3: error path — shows toast, clears loading", async () => {
    mockedOpenToday.mockRejectedValueOnce(new Error("server down"));

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    await act(async () => {
      await result.current.openToday();
    });

    expect(mockedOpenToday).toHaveBeenCalledTimes(1);
    expect(useTreeStore.getState().activeNoteId).toBe(null);
    expect(useTreeStore.getState().dailyNoteLoading).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it("DN-HOOK-4: re-entrancy guard — second openToday while in-flight is no-op", async () => {
    let resolve: (n: typeof fakeNote) => void = () => {};
    const pendingPromise = new Promise<typeof fakeNote>((r) => { resolve = r; });
    mockedOpenToday.mockReturnValueOnce(pendingPromise);

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    act(() => { void result.current.openToday(); });

    await waitFor(() => {
      expect(useTreeStore.getState().dailyNoteLoading).toBe(true);
    });

    await act(async () => {
      await result.current.openToday();
    });

    expect(mockedOpenToday).toHaveBeenCalledTimes(1);

    act(() => { resolve(fakeNote); });
    await waitFor(() => {
      expect(useTreeStore.getState().dailyNoteLoading).toBe(false);
    });
  });

  it("DN-HOOK-5: openToday passes the exact LOCAL YYYY-MM-DD date string to openTodayDailyNote", async () => {
    // Pinned via vi.setSystemTime + TZ (DN-HOOK-9 idiom) so the
    // expected date string is computed once, deterministically, instead of
    // racing a second `new Date()` call against the hook's internal one
    // across a local-midnight boundary.
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-02T12:00:00-07:00"));
      mockedOpenToday.mockResolvedValueOnce(fakeNote);

      const { result } = renderHook(() => useDailyNote(), { wrapper });

      await act(async () => {
        await result.current.openToday();
      });

      const dateArg = mockedOpenToday.mock.calls[0][0];
      expect(dateArg).toBe("2026-07-02");
    } finally {
      vi.useRealTimers();
      // Assigning undefined here would coerce TZ to the literal string
      // "undefined" (an invalid IANA zone), corrupting later date tests
      // that share this worker.
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });

  it("DN-HOOK-9: uses the LOCAL calendar date, not UTC", async () => {
    // Pin the process TZ to Pacific so this test is deterministic regardless
    // of the host/CI machine's own timezone (Node re-reads process.env.TZ
    // per Date construction, so this reliably shifts `new Date()` locals).
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    vi.useFakeTimers();
    try {
      // 2026-07-02T23:30:00 Pacific is 2026-07-03 in UTC —
      // asserts the implementation does NOT read the UTC-shifted day.
      vi.setSystemTime(new Date("2026-07-02T23:30:00-07:00"));
      mockedOpenToday.mockResolvedValueOnce(fakeNote);

      const { result } = renderHook(() => useDailyNote(), { wrapper });
      await act(async () => {
        await result.current.openToday();
      });

      expect(mockedOpenToday.mock.calls[0][0]).toBe("2026-07-02");
    } finally {
      vi.useRealTimers();
      // Assigning undefined here would coerce TZ to the literal string
      // "undefined" (an invalid IANA zone), corrupting later date tests
      // that share this worker.
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });

  it("DN-HOOK-6: happy path — broadcastRefresh is called after setActiveNote", async () => {
    mockedOpenToday.mockResolvedValueOnce(fakeNote);

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    await act(async () => {
      await result.current.openToday();
    });

    expect(mockedBroadcastRefresh).toHaveBeenCalledTimes(1);
  });

  it("DN-HOOK-8: happy path — opens a tab in the active pane for the created note id (RIBBON-04 gap 2)", async () => {
    mockedOpenToday.mockResolvedValueOnce(fakeNote);
    const openInActivePaneSpy = vi.spyOn(usePaneStore.getState(), "openInActivePane");

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    await act(async () => {
      await result.current.openToday();
    });

    expect(openInActivePaneSpy).toHaveBeenCalledTimes(1);
    expect(openInActivePaneSpy).toHaveBeenCalledWith(fakeNote.id);
    // Legacy pointer is still set for the zero-tab fallback pane.
    expect(useTreeStore.getState().activeNoteId).toBe(fakeNote.id);
  });

  it("DN-HOOK-7: error path — broadcastRefresh is NOT called on failure", async () => {
    mockedOpenToday.mockRejectedValueOnce(new Error("server down"));

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    await act(async () => {
      await result.current.openToday();
    });

    expect(mockedBroadcastRefresh).toHaveBeenCalledTimes(0);
  });

  it("broadcastRefresh rejects — note still opens, no 'couldn't open' toast fires", async () => {
    mockedOpenToday.mockResolvedValueOnce(fakeNote);
    mockedBroadcastRefresh.mockRejectedValueOnce(new Error("tree refresh failed"));
    const openInActivePaneSpy = vi.spyOn(usePaneStore.getState(), "openInActivePane");

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    await act(async () => {
      await result.current.openToday();
    });

    expect(useTreeStore.getState().activeNoteId).toBe(fakeNote.id);
    expect(openInActivePaneSpy).toHaveBeenCalledWith(fakeNote.id);
    expect(
      screen.queryByText("Couldn't open today's daily note"),
    ).not.toBeInTheDocument();
  });

  it("DN-HOOK-10: happy path — expands the note's containing folder (pp9)", async () => {
    mockedOpenToday.mockResolvedValueOnce(fakeNote);

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    await act(async () => {
      await result.current.openToday();
    });

    expect(useTreeStore.getState().expanded.has("daily")).toBe(true);
  });

  it("DN-HOOK-11: derivation, not a literal — nested note expands all ancestor folders (pp9)", async () => {
    const nestedNote = {
      ...fakeNote,
      path: "work/journals/2026-05-14.md",
    };
    mockedOpenToday.mockResolvedValueOnce(nestedNote);

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    await act(async () => {
      await result.current.openToday();
    });

    const expanded = useTreeStore.getState().expanded;
    expect(expanded.has("work")).toBe(true);
    expect(expanded.has("work/journals")).toBe(true);
  });

  it("DN-HOOK-12: open failure — expands nothing (pp9)", async () => {
    mockedOpenToday.mockRejectedValueOnce(new Error("server down"));

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    await act(async () => {
      await result.current.openToday();
    });

    expect(useTreeStore.getState().expanded.size).toBe(0);
  });

  it("DN-HOOK-13: broadcastRefresh rejects — still expands the folder, still no failure toast (pp9)", async () => {
    mockedOpenToday.mockResolvedValueOnce(fakeNote);
    mockedBroadcastRefresh.mockRejectedValueOnce(new Error("tree refresh failed"));

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    await act(async () => {
      await result.current.openToday();
    });

    expect(useTreeStore.getState().expanded.has("daily")).toBe(true);
    expect(useTreeStore.getState().activeNoteId).toBe(fakeNote.id);
    expect(
      screen.queryByText("Couldn't open today's daily note"),
    ).not.toBeInTheDocument();
  });

  it("DN-HOOK-14: ordering — expansion happens only after broadcastRefresh() settles (pp9)", async () => {
    mockedOpenToday.mockResolvedValueOnce(fakeNote);
    let resolveRefresh: () => void = () => {};
    const deferred = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    mockedBroadcastRefresh.mockReturnValueOnce(deferred);

    const { result } = renderHook(() => useDailyNote(), { wrapper });

    let openPromise!: Promise<void>;
    act(() => {
      openPromise = result.current.openToday();
    });

    await waitFor(() => {
      expect(mockedBroadcastRefresh).toHaveBeenCalledTimes(1);
    });
    expect(useTreeStore.getState().expanded.size).toBe(0);

    await act(async () => {
      resolveRefresh();
      await openPromise;
    });

    expect(useTreeStore.getState().expanded.has("daily")).toBe(true);
  });
});
