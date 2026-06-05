/**
 * useVaultPicker tests — Plan 08-17c Task 1 (TDD GREEN).
 *
 * Tests that the hook:
 * - Calls getCurrent + getRecent on mount
 * - open() flips isOpen to true; close() flips to false
 * - refresh() re-fetches both endpoints
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";


vi.mock("./vaultApi", () => ({
  vaultApi: {
    getCurrent: vi.fn().mockResolvedValue(null),
    getRecent: vi.fn().mockResolvedValue({ vaults: [], banner: "" }),
    open: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
    forget: vi.fn().mockResolvedValue(undefined),
  },
  validateVaultPath: vi.fn().mockReturnValue({ ok: true }),
}));

import { useVaultPicker } from "./useVaultPicker";
import { useTreeStore } from "./useTreeStore";
import { vaultApi } from "./vaultApi";

describe("useVaultPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTreeStore.getState().setVaultPickerOpen(false);
    vi.mocked(vaultApi.getCurrent).mockResolvedValue(null);
    vi.mocked(vaultApi.getRecent).mockResolvedValue({ vaults: [], banner: "" });
  });

  it("calls getCurrent and getRecent on mount", async () => {
    const { result } = renderHook(() => useVaultPicker());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(vaultApi.getCurrent).toHaveBeenCalledTimes(1);
    expect(vaultApi.getRecent).toHaveBeenCalledTimes(1);

    expect(result.current.current).toBeNull();
    expect(result.current.recents).toEqual([]);
    expect(result.current.banner).toBe("");
  });

  it("open() flips isOpen to true", () => {
    const { result } = renderHook(() => useVaultPicker());

    expect(result.current.isOpen).toBe(false);

    act(() => {
      result.current.open();
    });

    expect(result.current.isOpen).toBe(true);
  });

  it("close() flips isOpen to false", () => {
    const { result } = renderHook(() => useVaultPicker());

    act(() => {
      result.current.open();
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.close();
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("refresh() re-fetches getCurrent and getRecent", async () => {
    const { result } = renderHook(() => useVaultPicker());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const getCalls = vi.mocked(vaultApi.getCurrent).mock.calls.length;
    const getRecentCalls = vi.mocked(vaultApi.getRecent).mock.calls.length;

    await act(async () => {
      await result.current.refresh();
    });

    expect(vi.mocked(vaultApi.getCurrent).mock.calls.length).toBeGreaterThan(getCalls);
    expect(vi.mocked(vaultApi.getRecent).mock.calls.length).toBeGreaterThan(getRecentCalls);
  });

  it("isLoading is true during fetch and false after", async () => {
    const { result } = renderHook(() => useVaultPicker());

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.isLoading).toBe(false);
  });
});
