/**
 * Tests for useReveal hook.
 *
 * Coverage (Plan 08-06 Task 1 done criteria: all 5 toast scenarios):
 *   - REVEAL-HOOK-1: darwin success → toast "Opened in Finder" + variant info
 *   - REVEAL-HOOK-2: wsl2 success   → toast "Opened in Explorer" + variant info
 *   - REVEAL-HOOK-3: 501 native Linux → toast "Show in file manager isn't supported on Linux yet"
 *   - REVEAL-HOOK-4: generic non-2xx → toast "Could not open file manager"
 *   - REVEAL-HOOK-5: re-entrancy   → second reveal() while in-flight is a no-op
 *
 * revealPath is mocked at the module boundary so no network call occurs.
 * useToast is provided via the real ToastProvider — we spy on it via a
 * mock-wrapped toast() function injected through a custom provider wrapper,
 * mirroring the spy approach used elsewhere in the project. Toast.tsx's
 * own enqueue setter is the source of truth, but for assertions we capture
 * the calls via mocking the Toast module's useToast export.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock revealPath at the module boundary. The hook imports it from "./revealApi".
vi.mock("./revealApi", () => ({
  revealPath: vi.fn(),
}));

// Capture toast() calls by mocking useToast — the hook imports it from
// "../components/Toast". Returning a stable mock fn from useToast lets each
// test assert title/description/variant without rendering the real toast DOM.
const toastSpy = vi.fn();
vi.mock("../components/Toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import { revealPath } from "./revealApi";
import { useReveal } from "./useReveal";

const mockedRevealPath = vi.mocked(revealPath);

describe("useReveal", () => {
  beforeEach(() => {
    mockedRevealPath.mockReset();
    toastSpy.mockReset();
  });

  it("REVEAL-HOOK-1: darwin success fires 'Opened in Finder' info toast", async () => {
    mockedRevealPath.mockResolvedValueOnce({
      ok: true,
      platform: "darwin",
      status: 200,
    });

    const { result } = renderHook(() => useReveal());

    await act(async () => {
      await result.current.reveal("projects/jasper/note.md");
    });

    expect(mockedRevealPath).toHaveBeenCalledWith("projects/jasper/note.md");
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const arg = toastSpy.mock.calls[0][0];
    expect(arg.title).toBe("Opened in Finder");
    expect(arg.variant).toBe("info");
  });

  it("REVEAL-HOOK-2: wsl2 success fires 'Opened in Explorer' info toast", async () => {
    mockedRevealPath.mockResolvedValueOnce({
      ok: true,
      platform: "wsl2",
      status: 200,
    });

    const { result } = renderHook(() => useReveal());

    await act(async () => {
      await result.current.reveal("daily/2026-05-18.md");
    });

    expect(toastSpy).toHaveBeenCalledTimes(1);
    const arg = toastSpy.mock.calls[0][0];
    expect(arg.title).toBe("Opened in Explorer");
    expect(arg.variant).toBe("info");
  });

  it("REVEAL-HOOK-3: 501 native Linux fires Linux-specific error toast with abs-path description", async () => {
    mockedRevealPath.mockResolvedValueOnce({
      ok: false,
      status: 501,
      errorMessage:
        "Show in file manager isn't supported on Linux yet. The file is at /home/user/.jasper/notes/foo.md.",
    });

    const { result } = renderHook(() => useReveal());

    await act(async () => {
      await result.current.reveal("foo.md");
    });

    expect(toastSpy).toHaveBeenCalledTimes(1);
    const arg = toastSpy.mock.calls[0][0];
    expect(arg.title).toBe("Show in file manager isn't supported on Linux yet");
    expect(arg.variant).toBe("error");
    expect(arg.description).toContain("The file is at");
  });

  it("REVEAL-HOOK-4: generic non-2xx fires 'Could not open file manager' error toast", async () => {
    mockedRevealPath.mockResolvedValueOnce({
      ok: false,
      status: 500,
      errorMessage: "exec_failed",
    });

    const { result } = renderHook(() => useReveal());

    await act(async () => {
      await result.current.reveal("note.md");
    });

    expect(toastSpy).toHaveBeenCalledTimes(1);
    const arg = toastSpy.mock.calls[0][0];
    expect(arg.title).toBe("Could not open file manager");
    expect(arg.variant).toBe("error");
    expect(arg.description).toBe("exec_failed");
  });

  it("REVEAL-HOOK-5: re-entrancy guard — second reveal() while in-flight is a no-op", async () => {
    // First call returns a pending promise so loading stays true while we fire
    // the second one. Mirrors useDailyNote's DN-HOOK-4 pattern.
    let resolve: (v: { ok: true; platform: "darwin"; status: 200 }) => void = () => {};
    const pending = new Promise<{ ok: true; platform: "darwin"; status: 200 }>(
      (r) => {
        resolve = r;
      },
    );
    mockedRevealPath.mockReturnValueOnce(pending);

    const { result } = renderHook(() => useReveal());

    // Start first call (don't await).
    act(() => {
      void result.current.reveal("a.md");
    });

    // Wait for `loading` to flip true so the guard is armed.
    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    // Fire second call while first is in flight.
    await act(async () => {
      await result.current.reveal("b.md");
    });

    // Only the first call reached revealPath; second was guarded.
    expect(mockedRevealPath).toHaveBeenCalledTimes(1);

    // Resolve the first call to clean up the hanging promise.
    act(() => {
      resolve({ ok: true, platform: "darwin", status: 200 });
    });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Resolution toasts once for the first call (success).
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][0].title).toBe("Opened in Finder");
  });
});
