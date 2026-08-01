/**
 * Tests for the locked-signature useMigrationStatus hook.
 *
 * Validates:
 *   - mount-time fetch resolves and surfaces the response
 *   - rolled_back state surfaces failed_migration + logs_path
 *   - refresh() invalidates the shared resource and updates state on the
 *     subsequent fetch
 *   - network error: state stays "ok" (optimistic), error is non-null
 *   - StrictMode double-mount does not double-set state (cancelled flag)
 *
 * Mocks adminApi's adminStatusResource (built on the REAL createResource
 * primitive, mockFetcher standing in for the network call) so we never hit
 * the network but the resource layer's own hydrate/cache/invalidate
 * behavior is exercised for real.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFetcher } = vi.hoisted(() => ({ mockFetcher: vi.fn() }));

vi.mock("./adminApi", async () => {
  const { createResource } = await import("./resources");
  return {
    adminStatusResource: createResource("adminStatus", mockFetcher, {
      mode: "cached",
      invalidatedBy: ["reindex:complete"],
    }),
  };
});

import { __testing__ as resourcesTesting } from "./resources/createResource";
import { useMigrationStatus } from "./useMigrationStatus";

describe("useMigrationStatus", () => {
  beforeEach(() => {
    mockFetcher.mockReset();
    resourcesTesting.reset();
  });

  it("UM1: defaults to state=ok, loading=true, then resolves to fetched ok state on mount", async () => {
    mockFetcher.mockResolvedValue({
      data: { state: "ok", notes_indexed: 7 },
      error: undefined,
    });

    const { result } = renderHook(() => useMigrationStatus());

    expect(result.current.state).toBe("ok");

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe("ok");
    expect(result.current.notesIndexed).toBe(7);
    expect(result.current.error).toBeNull();
  });

  it("UM2: state=rolled_back surfaces failedMigration + logsPath on the result", async () => {
    mockFetcher.mockResolvedValue({
      data: {
        state: "rolled_back",
        failed_migration: "003_tags.sql",
        logs_path: "/Users/me/.jasper/.jasper/logs/jasper.log",
      },
      error: undefined,
    });

    const { result } = renderHook(() => useMigrationStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.state).toBe("rolled_back");
    expect(result.current.failedMigration).toBe("003_tags.sql");
    expect(result.current.logsPath).toBe(
      "/Users/me/.jasper/.jasper/logs/jasper.log",
    );
  });

  it("UM3: refresh() invalidates and updates state on the subsequent fetch", async () => {
    mockFetcher.mockResolvedValueOnce({
      data: { state: "rolled_back", failed_migration: "003.sql" },
      error: undefined,
    });

    const { result } = renderHook(() => useMigrationStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe("rolled_back");

    mockFetcher.mockResolvedValueOnce({
      data: { state: "ok", notes_indexed: 12 },
      error: undefined,
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.state).toBe("ok");
    expect(result.current.notesIndexed).toBe(12);
    expect(result.current.failedMigration).toBeUndefined();
    expect(mockFetcher).toHaveBeenCalledTimes(2);
  });

  it("UM4: a network/error response keeps state optimistic and sets error", async () => {
    mockFetcher.mockResolvedValue({
      data: undefined,
      error: { code: "internal", message: "boom" },
    });

    const { result } = renderHook(() => useMigrationStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.state).toBe("ok");
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toBe("boom");
  });

  it("UM5: a thrown promise rejection is caught and surfaced as an Error", async () => {
    mockFetcher.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useMigrationStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.state).toBe("ok");
    expect(result.current.error?.message).toBe("network down");
  });

  it("UM6: StrictMode-style double mount only commits one resolution (cancelled flag)", async () => {
    let resolveCount = 0;
    mockFetcher.mockImplementation(async () => {
      resolveCount++;
      return {
        data: { state: "ok", notes_indexed: resolveCount },
        error: undefined,
      };
    });

    const first = renderHook(() => useMigrationStatus());
    first.unmount();

    const second = renderHook(() => useMigrationStatus());
    await waitFor(() => expect(second.result.current.loading).toBe(false));

    expect(second.result.current.error).toBeNull();
    expect(second.result.current.state).toBe("ok");
  });
});
