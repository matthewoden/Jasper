/**
 * useAccent.test — verifies --color-accent and --font-reading are applied
 * and persisted; verifies rollback on saveConfig error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn(),
    PUT: vi.fn(),
    PATCH: vi.fn(),
  },
}));

import { client } from "../api/client";
import { __testing__ as resourcesTesting } from "./resources/createResource";
import { __testing__ as configApiTesting } from "./configApi";
import {
  applyAccent,
  applyReadingFont,
  persistAccentBootstrap,
  useAccent,
} from "./useAccent";

const mockClient = client as unknown as {
  GET: ReturnType<typeof vi.fn>;
  PUT: ReturnType<typeof vi.fn>;
  PATCH: ReturnType<typeof vi.fn>;
};

const sampleConfig = {
  appName: "Jasper",
  theme: "dark" as const,
  dailyNotes: { template: "" },
  editor: {
    fontSize: 15,
    lineHeight: 1.6,
    autosaveMs: 2000,
    showProperties: true,
    autoPair: true,
    foldGutter: true,
    lineNumbers: false,
    lineWidth: 700,
  },
  accent: "purple" as const,
  readingFont: "sans" as const,
};

const SERIF_STACK = "'Source Serif 4', Georgia, 'Times New Roman', serif";

beforeEach(() => {
  mockClient.GET.mockReset();
  mockClient.PUT.mockReset();
  mockClient.PATCH.mockReset();
  // configResource is a module-level, boot-scoped singleton shared
  // by every useAccent()/useConfig() instance — without this reset, a
  // later test's mount reads the PRIOR test's cached (possibly mutated)
  // config instead of issuing its own GET.
  resourcesTesting.reset();
  configApiTesting.reset();
  localStorage.clear();
  document.documentElement.style.removeProperty("--color-accent");
  document.documentElement.style.removeProperty("--font-reading");
});

describe("applyAccent", () => {
  it("maps sky to #7dd3fc and sets --color-accent inline style", () => {
    applyAccent("sky");
    expect(
      document.documentElement.style.getPropertyValue("--color-accent"),
    ).toBe("#7dd3fc");
  });

  it("falls back to #a78bfa (purple) for an unknown accent key", () => {
    applyAccent("bogus");
    expect(
      document.documentElement.style.getPropertyValue("--color-accent"),
    ).toBe("#a78bfa");
  });
});

describe("applyReadingFont", () => {
  it("sets --font-reading to the Source Serif 4 stack when serif", () => {
    applyReadingFont("serif");
    expect(
      document.documentElement.style.getPropertyValue("--font-reading"),
    ).toBe(SERIF_STACK);
  });

  it("removes --font-reading inline override when sans (falls back to :root)", () => {
    document.documentElement.style.setProperty("--font-reading", SERIF_STACK);
    applyReadingFont("sans");
    expect(
      document.documentElement.style.getPropertyValue("--font-reading"),
    ).toBe("");
  });
});

describe("persistAccentBootstrap", () => {
  it("writes value to localStorage['jasper:accent-bootstrap']", () => {
    persistAccentBootstrap("sky");
    expect(localStorage.getItem("jasper:accent-bootstrap")).toBe("sky");
  });
});

describe("useAccent", () => {
  it("syncs --color-accent from config.accent on mount", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    renderHook(() => useAccent());
    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue("--color-accent"),
      ).toBe("#a78bfa");
    });
  });

  it("setAccent applies optimistically and persists config via PATCH with a one-key body", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    mockClient.PATCH.mockResolvedValue({
      data: { ...sampleConfig, accent: "sky" },
      response: { status: 200 },
    });
    const { result } = renderHook(() => useAccent());
    // Wait until config has loaded and useEffect has synced DOM (not just GET called)
    await waitFor(() =>
      expect(
        document.documentElement.style.getPropertyValue("--color-accent"),
      ).toBe("#a78bfa"),
    );
    await act(async () => {
      await result.current.setAccent("sky");
    });
    expect(
      document.documentElement.style.getPropertyValue("--color-accent"),
    ).toBe("#7dd3fc");
    expect(mockClient.PATCH).toHaveBeenCalledTimes(1);
    const body = mockClient.PATCH.mock.calls[0][1].body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["accent"]);
    expect(body.accent).toBe("sky");
  });

  it("setReadingFont persists via PATCH with a one-key body", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    mockClient.PATCH.mockResolvedValue({
      data: { ...sampleConfig, readingFont: "serif" },
      response: { status: 200 },
    });
    const { result } = renderHook(() => useAccent());
    await waitFor(() =>
      expect(
        document.documentElement.style.getPropertyValue("--color-accent"),
      ).toBe("#a78bfa"),
    );
    await act(async () => {
      await result.current.setReadingFont("serif");
    });
    expect(mockClient.PATCH).toHaveBeenCalledTimes(1);
    const body = mockClient.PATCH.mock.calls[0][1].body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["readingFont"]);
    expect(body.readingFont).toBe("serif");
  });

  it("rolls back --color-accent to previous value on saveConfig error", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    mockClient.PATCH.mockResolvedValue({
      error: { code: "internal", message: "save failed" },
      response: { status: 500 },
    });
    const { result } = renderHook(() => useAccent());
    await waitFor(() =>
      expect(
        document.documentElement.style.getPropertyValue("--color-accent"),
      ).toBe("#a78bfa"),
    );
    let res: Awaited<ReturnType<typeof result.current.setAccent>> | undefined;
    await act(async () => {
      res = await result.current.setAccent("sky");
    });
    expect(res?.error).toBeDefined();
    expect(
      document.documentElement.style.getPropertyValue("--color-accent"),
    ).toBe("#a78bfa");
  });
});
