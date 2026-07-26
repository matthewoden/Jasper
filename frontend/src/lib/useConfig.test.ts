/**
 * useConfig.test — verifies the hook fetches GET /config on mount
 * and saveConfig dispatches PUT /config + updates state optimistically.
 *
 * Mocks the openapi-fetch client at the module level via vi.mock.
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
import { useConfig, getConfig, putConfig } from "./useConfig";

const mockClient = client as unknown as {
  GET: ReturnType<typeof vi.fn>;
  PUT: ReturnType<typeof vi.fn>;
};

const sampleConfig = {
  appName: "Jasper",
  theme: "dark" as const,
  accent: "purple" as const,
  readingFont: "sans" as const,
  dailyNotes: { folder: "daily", template: "" },
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
};

beforeEach(() => {
  mockClient.GET.mockReset();
  mockClient.PUT.mockReset();
});

describe("useConfig", () => {
  it("fetches GET /config on mount and exposes the result", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    const { result } = renderHook(() => useConfig());
    await waitFor(() => {
      expect(result.current.config).not.toBeNull();
    });
    expect(result.current.config?.theme).toBe("dark");
  });

  it("saveConfig dispatches PUT /config and updates optimistic state", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    const next = { ...sampleConfig, theme: "light" as const };
    mockClient.PUT.mockResolvedValue({ data: next, response: { status: 200 } });
    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());
    await act(async () => {
      await result.current.saveConfig(next);
    });
    expect(result.current.config?.theme).toBe("light");
  });

  it("saveConfig returns an error when PUT fails", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    mockClient.PUT.mockResolvedValue({
      error: { code: "invalid_request", message: "bad" },
      response: { status: 400 },
    });
    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());
    let saveResult: Awaited<ReturnType<typeof result.current.saveConfig>> | undefined;
    await act(async () => {
      saveResult = await result.current.saveConfig({ ...sampleConfig, theme: "light" });
    });
    expect(saveResult?.error?.code).toBe("invalid_request");
  });

  it("CR-02: failed save rolls back to last persisted config, not an optimistic intermediate", async () => {
    // Setup: GET returns the original sampleConfig (theme: dark).
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    // First PUT succeeds (changes fontSize to 18).
    const afterFirstSave = { ...sampleConfig, editor: { ...sampleConfig.editor, fontSize: 18 } };
    // Second PUT fails.
    mockClient.PUT.mockResolvedValueOnce({ data: afterFirstSave, response: { status: 200 } })
                  .mockResolvedValueOnce({
                    error: { code: "invalid_request", message: "out of range" },
                    response: { status: 400 },
                  });

    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());

    // First save succeeds: config becomes afterFirstSave.
    await act(async () => {
      await result.current.saveConfig(afterFirstSave);
    });
    expect(result.current.config?.editor.fontSize).toBe(18);

    // Second save fails: optimistic value is applied then rolled back.
    const optimisticSecond = { ...afterFirstSave, editor: { ...afterFirstSave.editor, fontSize: 99 } };
    await act(async () => {
      await result.current.saveConfig(optimisticSecond);
    });

    // After rollback, config must be afterFirstSave (last persisted), NOT sampleConfig.
    // The stale-closure bug (CR-02) would have rolled back to sampleConfig (theme: dark,
    // fontSize: 15) because prev was captured from the first optimistic update.
    expect(result.current.config?.editor.fontSize).toBe(18);
  });
});

describe("getConfig + putConfig wrappers", () => {
  it("getConfig wraps client.GET response in { data, error } shape", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    const { data } = await getConfig();
    expect(data?.theme).toBe("dark");
  });

  it("putConfig wraps error responses with status code", async () => {
    mockClient.PUT.mockResolvedValue({
      error: { code: "invalid_request", message: "bad" },
      response: { status: 400 },
    });
    const { error } = await putConfig({ ...sampleConfig, theme: "light" });
    expect(error?.status).toBe(400);
    expect(error?.code).toBe("invalid_request");
  });
});
