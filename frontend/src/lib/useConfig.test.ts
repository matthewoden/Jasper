/**
 * Mocks the openapi-fetch client at the module level, so configApi.ts and the
 * resource layer run for real underneath and the overlapping-save interleaving
 * exercises the actual mutate()/rollback machinery.
 *
 * Resource-layer state is module-global, so every test resets both
 * createResource's registry and configApi's lastPersisted between cases.
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
import { __testing__ as configApiTesting, putConfig, patchConfig } from "./configApi";
import { useConfig } from "./useConfig";

const mockClient = client as unknown as {
  GET: ReturnType<typeof vi.fn>;
  PUT: ReturnType<typeof vi.fn>;
  PATCH: ReturnType<typeof vi.fn>;
};

const sampleConfig = {
  appName: "Jasper",
  theme: "dark" as const,
  accent: "purple" as const,
  readingFont: "sans" as const,
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
};

beforeEach(() => {
  mockClient.GET.mockReset();
  mockClient.PUT.mockReset();
  mockClient.PATCH.mockReset();
  resourcesTesting.reset();
  configApiTesting.reset();
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

  it("saveConfig dispatches PATCH /config with a body containing only the caller's keys", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    mockClient.PATCH.mockResolvedValue({
      data: { ...sampleConfig, theme: "light" as const },
      response: { status: 200 },
    });
    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());
    await act(async () => {
      await result.current.saveConfig({ theme: "light" });
    });
    expect(mockClient.PATCH).toHaveBeenCalledTimes(1);
    const body = mockClient.PATCH.mock.calls[0][1].body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["theme"]);
    expect(result.current.config?.theme).toBe("light");
  });

  it("saveConfig merges the patch into the last persisted config for the optimistic frame", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    // Never resolves during the assertion window, so we can inspect the
    // optimistic frame set before the server responds.
    let resolvePatch: (v: { data: typeof sampleConfig; response: { status: number } }) => void =
      () => {};
    mockClient.PATCH.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePatch = resolve;
        }),
    );
    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());

    act(() => {
      void result.current.saveConfig({ editor: { fontSize: 18 } });
    });

    await waitFor(() => expect(result.current.config?.editor.fontSize).toBe(18));
    // Deep merge proof: fontSize changed but the rest of editor survives.
    expect(result.current.config?.editor.autosaveMs).toBe(sampleConfig.editor.autosaveMs);
    expect(result.current.config?.editor.lineHeight).toBe(sampleConfig.editor.lineHeight);

    await act(async () => {
      resolvePatch({
        data: { ...sampleConfig, editor: { ...sampleConfig.editor, fontSize: 18 } },
        response: { status: 200 },
      });
      await Promise.resolve();
    });
  });

  it("saveConfig returns an error when PATCH fails", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    mockClient.PATCH.mockResolvedValue({
      error: { code: "invalid_request", message: "bad" },
      response: { status: 400 },
    });
    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());
    let saveResult: Awaited<ReturnType<typeof result.current.saveConfig>> | undefined;
    await act(async () => {
      saveResult = await result.current.saveConfig({ theme: "light" });
    });
    expect(saveResult?.error?.code).toBe("invalid_request");
  });

  it("failed save rolls back to last persisted config, not an optimistic intermediate", async () => {
    // Setup: GET returns the original sampleConfig (theme: dark).
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    // First PATCH succeeds (changes fontSize to 18).
    const afterFirstSave = { ...sampleConfig, editor: { ...sampleConfig.editor, fontSize: 18 } };
    // Second PATCH fails.
    mockClient.PATCH.mockResolvedValueOnce({ data: afterFirstSave, response: { status: 200 } })
      .mockResolvedValueOnce({
        error: { code: "invalid_request", message: "out of range" },
        response: { status: 400 },
      });

    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());

    // First save succeeds: config becomes afterFirstSave.
    await act(async () => {
      await result.current.saveConfig({ editor: { fontSize: 18 } });
    });
    expect(result.current.config?.editor.fontSize).toBe(18);

    // Second save fails: optimistic value is applied then rolled back.
    await act(async () => {
      await result.current.saveConfig({ editor: { fontSize: 99 } });
    });

    // After rollback, config must be afterFirstSave (last persisted), NOT sampleConfig.
    // The stale-closure bug would have rolled back to sampleConfig (theme: dark,
    // fontSize: 15) because prev was captured from the first optimistic update.
    expect(result.current.config?.editor.fontSize).toBe(18);
  });

  it("a failing save does not revert an overlapping save that already succeeded", async () => {
    // The test above awaits each save, so the two never overlap. This one
    // holds the first PATCH open, lets a second PATCH confirm while it is still
    // in flight, and only then fails the first.
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });

    let failFirst: (v: unknown) => void = () => {};
    const heldFirst = new Promise((resolve) => {
      failFirst = resolve;
    });
    const afterSecond = { ...sampleConfig, editor: { ...sampleConfig.editor, fontSize: 18 } };

    mockClient.PATCH
      // First call (accent) — resolution withheld until we release it.
      .mockImplementationOnce(() => heldFirst)
      // Second call (fontSize) — confirms immediately, server echoes fontSize 18.
      .mockResolvedValueOnce({ data: afterSecond, response: { status: 200 } });

    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());

    let firstSave: Promise<{ error?: unknown }> | undefined;
    await act(async () => {
      firstSave = result.current.saveConfig({ accent: "sky" });
      await Promise.resolve();
    });

    // Second save confirms while the first is still unresolved.
    await act(async () => {
      await result.current.saveConfig({ editor: { fontSize: 18 } });
    });
    expect(result.current.config?.editor.fontSize).toBe(18);

    // Now fail the first save.
    await act(async () => {
      failFirst({
        error: { code: "invalid_request", message: "bad accent" },
        response: { status: 400 },
      });
      await firstSave;
    });

    // The confirmed fontSize:18 must survive. Rolling back to the snapshot
    // captured before the first save would restore fontSize:15 and silently
    // discard a write the server already persisted.
    expect(result.current.config?.editor.fontSize).toBe(18);
    // The failed field must not be applied.
    expect(result.current.config?.accent).toBe("purple");
  });

  it("replaceConfig PUTs the whole document rebased on the freshest persisted config", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    const afterFirstSave = { ...sampleConfig, editor: { ...sampleConfig.editor, fontSize: 18 } };
    mockClient.PATCH.mockResolvedValue({ data: afterFirstSave, response: { status: 200 } });
    mockClient.PUT.mockResolvedValue({
      data: { ...afterFirstSave, editor: { ...afterFirstSave.editor, autosaveMs: 2000 } },
      response: { status: 200 },
    });

    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());

    // First save (PATCH) lands fontSize: 18.
    await act(async () => {
      await result.current.saveConfig({ editor: { fontSize: 18 } });
    });
    expect(result.current.config?.editor.fontSize).toBe(18);

    // replaceConfig with an unrelated patch must rebase onto the post-first-save
    // config, not a stale closure captured before the first save landed.
    await act(async () => {
      await result.current.replaceConfig({ editor: { autosaveMs: 2000 } });
    });

    expect(mockClient.PUT).toHaveBeenCalledTimes(1);
    const body = mockClient.PUT.mock.calls[0][1].body as { editor: { fontSize: number } };
    expect(body.editor.fontSize).toBe(18);
  });
});

// getConfig moved into configApi.ts and is module-private there now (it's
// the resource's fetcher, not a standalone wrapper) — its success/failure
// shape is covered by configApi.test.ts's boot-scoped-dedup and
// GET-failure-throws cases instead of here.
describe("putConfig + patchConfig wrappers", () => {
  it("putConfig wraps error responses with status code", async () => {
    mockClient.PUT.mockResolvedValue({
      error: { code: "invalid_request", message: "bad" },
      response: { status: 400 },
    });
    const { error } = await putConfig({ ...sampleConfig, theme: "light" });
    expect(error?.status).toBe(400);
    expect(error?.code).toBe("invalid_request");
  });

  it("patchConfig wraps error responses with status code", async () => {
    mockClient.PATCH.mockResolvedValue({
      error: { code: "invalid_request", message: "bad" },
      response: { status: 400 },
    });
    const { error } = await patchConfig({ theme: "light" });
    expect(error?.status).toBe(400);
    expect(error?.code).toBe("invalid_request");
  });
});
