/**
 * useTheme.test — verifies data-theme is applied + persisted on
 * setTheme; verifies bootstrap rollback on PUT failure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn(),
    PUT: vi.fn(),
  },
}));

import { client } from "../api/client";
import { useTheme, THEME_BOOTSTRAP_KEY } from "./useTheme";

const mockClient = client as unknown as {
  GET: ReturnType<typeof vi.fn>;
  PUT: ReturnType<typeof vi.fn>;
};

const sampleConfig = {
  appName: "Jasper",
  theme: "dark" as const,
  dailyNotes: { folder: "daily", template: "" },
  editor: { fontSize: 15, lineHeight: 1.6, vimMode: false },
};

beforeEach(() => {
  mockClient.GET.mockReset();
  mockClient.PUT.mockReset();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("useTheme", () => {
  it("applies data-theme='dark' from config on mount", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    renderHook(() => useTheme());
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
  });

  it("setTheme('light') flips data-theme + persists to LS bootstrap + saves config", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    mockClient.PUT.mockResolvedValue({
      data: { ...sampleConfig, theme: "light" },
      response: { status: 200 },
    });
    const { result } = renderHook(() => useTheme());
    // result.current.theme reads the DOM via getCurrentTheme, so it is
    // ALWAYS defined immediately. We need to wait until the GET-driven
    // config-arrives effect has actually run (the one that flips
    // data-theme + writes the LS bootstrap cache) — otherwise setTheme
    // takes the "config is null" early-return and never calls PUT.
    await waitFor(() => expect(mockClient.GET).toHaveBeenCalled());
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark"),
    );
    await act(async () => {
      await result.current.setTheme("light");
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_BOOTSTRAP_KEY)).toBe("light");
    expect(mockClient.PUT).toHaveBeenCalled();
  });

  it("on PUT failure: keeps in-memory theme but rolls back LS bootstrap", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    mockClient.PUT.mockResolvedValue({
      error: { code: "internal", message: "save failed" },
      response: { status: 500 },
    });
    const { result } = renderHook(() => useTheme());
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark"),
    );
    let res: Awaited<ReturnType<typeof result.current.setTheme>> | undefined;
    await act(async () => {
      res = await result.current.setTheme("light");
    });
    expect(res?.error).toBeDefined();
    // In-memory theme stays applied for the session.
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    // But LS bootstrap is rolled back so next reload reverts.
    expect(localStorage.getItem(THEME_BOOTSTRAP_KEY)).toBeNull();
  });
});
