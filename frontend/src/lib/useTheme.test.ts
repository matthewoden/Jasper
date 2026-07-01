/**
 * useTheme.test — dark-only behavior (Phase 17 D-01).
 * Verifies data-theme is always "dark"; light-theme assertions removed.
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
  editor: { fontSize: 15, lineHeight: 1.6, vimMode: false, autosaveMs: 2000 },
  accent: "purple" as const,
  readingFont: "sans" as const,
};

beforeEach(() => {
  mockClient.GET.mockReset();
  mockClient.PUT.mockReset();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("useTheme (dark-only)", () => {
  it("applies data-theme='dark' on config load", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    renderHook(() => useTheme());
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
  });

  it("setTheme always sets data-theme='dark' regardless of argument", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    const { result } = renderHook(() => useTheme());
    await waitFor(() => expect(mockClient.GET).toHaveBeenCalled());
    await act(async () => {
      await result.current.setTheme("light");
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_BOOTSTRAP_KEY)).toBe("dark");
  });

  it("returns theme='dark' always", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    const { result } = renderHook(() => useTheme());
    await waitFor(() => expect(mockClient.GET).toHaveBeenCalled());
    expect(result.current.theme).toBe("dark");
  });
});
