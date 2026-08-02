/**
 * useTheme.test — dark-only behavior.
 * The hook is config-independent: it applies data-theme="dark"
 * once on mount and setTheme always resolves to dark.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useTheme, THEME_BOOTSTRAP_KEY } from "./useTheme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("useTheme (dark-only)", () => {
  it("applies data-theme='dark' + bootstrap key on mount", () => {
    renderHook(() => useTheme());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_BOOTSTRAP_KEY)).toBe("dark");
  });

  it("setTheme always sets data-theme='dark' regardless of argument", async () => {
    const { result } = renderHook(() => useTheme());
    await act(async () => {
      await result.current.setTheme("light");
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_BOOTSTRAP_KEY)).toBe("dark");
  });

  it("returns theme='dark' always", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
  });
});
