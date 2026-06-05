/**
 * useVaultSwitch tests — Plan 08-17d Task 3.
 *
 * Tests the vault-switch overlay state management and the V4 10-second
 * failsafe reload scheduling via vi.useFakeTimers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";


const vaultSwitchingState = { active: false, targetName: "" };
const setVaultSwitchingMock = vi.fn((s: { active: boolean; targetName: string }) => {
  vaultSwitchingState.active = s.active;
  vaultSwitchingState.targetName = s.targetName;
});


const setActiveNoteMock = vi.fn();
const setActiveFilePathMock = vi.fn();

type StoreState = {
  vaultSwitching: typeof vaultSwitchingState;
  setVaultSwitching: typeof setVaultSwitchingMock;
  setActiveNote: typeof setActiveNoteMock;
  setActiveFilePath: typeof setActiveFilePathMock;
};

vi.mock("./useTreeStore", () => {
  const buildState = (): StoreState => ({
    vaultSwitching: vaultSwitchingState,
    setVaultSwitching: setVaultSwitchingMock,
    setActiveNote: setActiveNoteMock,
    setActiveFilePath: setActiveFilePathMock,
  });
  const fn = vi.fn((selector?: (s: StoreState) => unknown) => {
    const state = buildState();
    return selector ? selector(state) : state;
  });
  return {
    useTreeStore: Object.assign(fn, { getState: () => buildState() }),
  };
});

import { useVaultSwitch } from "./useVaultSwitch";


const reloadMock = vi.fn();
Object.defineProperty(window, "location", {
  value: { reload: reloadMock },
  writable: true,
});

describe("useVaultSwitch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reloadMock.mockClear();
    setVaultSwitchingMock.mockClear();
    setActiveNoteMock.mockClear();
    setActiveFilePathMock.mockClear();
    vaultSwitchingState.active = false;
    vaultSwitchingState.targetName = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initially not switching", () => {
    const { result } = renderHook(() => useVaultSwitch());
    expect(result.current.switching).toBe(false);
    expect(result.current.targetName).toBe("");
  });

  it("markSwitching sets active=true and targetName", () => {
    const { result } = renderHook(() => useVaultSwitch());
    act(() => {
      result.current.markSwitching("Work Vault");
    });
    expect(setVaultSwitchingMock).toHaveBeenCalledWith({
      active: true,
      targetName: "Work Vault",
    });
  });

  it("markSwitching schedules 10s failsafe reload (V4)", () => {
    const { result } = renderHook(() => useVaultSwitch());
    act(() => {
      result.current.markSwitching("Work Vault");
    });
    vi.advanceTimersByTime(9999);
    expect(reloadMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("markSwitched calls window.location.reload immediately", () => {
    const { result } = renderHook(() => useVaultSwitch());
    act(() => {
      result.current.markSwitched();
    });
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});
