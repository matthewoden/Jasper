/**
 * Tests for useMcpGrants hook.
 * Covers mount (fetch-once via the shared resource cache), WS-triggered
 * refresh, levelFor ancestor walk, directLevelFor direct-only match, toast
 * copy for grant/upgrade/downgrade/revoke/error, and the D-11/D-14 fetch-once
 * property across multiple mounted consumers.
 *
 * `mcpGrantsResource` is built with the REAL `createResource` (not mocked)
 * so the resource layer's coalescing/invalidation/mutate semantics are
 * exercised for real — only the network-facing `listGrants`/`postGrant`/
 * `deleteGrant` fetchers are mocked via `./mcpGrantsApi`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

const listGrantsMock = vi.fn();
const postGrantMock = vi.fn();
const deleteGrantMock = vi.fn();

vi.mock("./mcpGrantsApi", async () => {
  const { createResource } = await import("./resources/createResource");
  return {
    mcpGrantsResource: createResource("mcpGrants", () => listGrantsMock(), {
      mode: "cached",
      invalidatedBy: ["mcp:grant_changed"],
    }),
    postGrant: (...args: unknown[]) => postGrantMock(...args),
    deleteGrant: (...args: unknown[]) => deleteGrantMock(...args),
  };
});

const toastSpy = vi.fn();
vi.mock("../components/toast.utils", () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));

import { mcpGrantsResource } from "./mcpGrantsApi";
import { useMcpGrants, __testing__ } from "./useMcpGrants";

const grantProjects = {
  folder_path: "projects",
  level: 1 as const,
  granted_at: "2026-05-17T10:00:00Z",
  granted_via: "tree-context-menu",
};
const grantProjectsUpgraded = { ...grantProjects, level: 2 as const };

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement("div", null, children);

describe("useMcpGrants", () => {
  beforeEach(() => {
    listGrantsMock.mockReset();
    postGrantMock.mockReset();
    deleteGrantMock.mockReset();
    toastSpy.mockReset();
    // Per-entry reset (not the global registry reset): the eventBus
    // subscription createResource() wires up at module-load time inside
    // the mock factory above must survive across tests, or the
    // mcp:grant_changed WS-invalidation cases below (M2) would only work
    // once. clear() resets cached data/hydrated/error without touching
    // that subscription. Auto-cleanup (@testing-library/react) unmounts
    // every renderHook after each test, so entry.listeners returns to 0
    // between tests regardless.
    mcpGrantsResource.clear();
  });

  it("M1: mount calls listGrants once and populates the cache", async () => {
    listGrantsMock.mockResolvedValue([grantProjects]);

    const { result } = renderHook(() => useMcpGrants(), { wrapper });

    await waitFor(() => {
      expect(result.current.grants).toEqual([grantProjects]);
    });
    expect(listGrantsMock).toHaveBeenCalledTimes(1);
  });

  it("M2: simulateEvent dispatches refresh — listGrants called again", async () => {
    listGrantsMock.mockResolvedValue([grantProjects]);

    const { result } = renderHook(() => useMcpGrants(), { wrapper });
    await waitFor(() => expect(result.current.grants).toEqual([grantProjects]));

    listGrantsMock.mockResolvedValue([grantProjects, {
      folder_path: "inbox",
      level: 2,
      granted_at: "2026-05-17T11:00:00Z",
      granted_via: "tree-context-menu",
    }]);

    act(() => {
      __testing__.simulateEvent();
    });

    await waitFor(() => {
      expect(listGrantsMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.grants.length).toBe(2);
    });
  });

  it("M3: levelFor walks ancestors — grant on 'projects' covers descendants", async () => {
    listGrantsMock.mockResolvedValue([grantProjects]);

    const { result } = renderHook(() => useMcpGrants(), { wrapper });
    await waitFor(() => expect(result.current.grants.length).toBe(1));

    expect(result.current.levelFor("projects")).toBe(1);
    expect(result.current.levelFor("projects/ai")).toBe(1);
    expect(result.current.levelFor("projects/ai/draft.md")).toBe(1);
    expect(result.current.levelFor("inbox")).toBeNull();
  });

  it("M4: directLevelFor matches ONLY the attached folder", async () => {
    listGrantsMock.mockResolvedValue([grantProjects]);

    const { result } = renderHook(() => useMcpGrants(), { wrapper });
    await waitFor(() => expect(result.current.grants.length).toBe(1));

    expect(result.current.directLevelFor("projects")).toBe(1);
    expect(result.current.directLevelFor("projects/ai")).toBeNull();
    expect(result.current.directLevelFor("inbox")).toBeNull();
  });

  it("M5: grant Tier 1 then upgrade Tier 2 — locked toasts (granted → upgraded)", async () => {
    listGrantsMock.mockResolvedValue([]);

    const { result } = renderHook(() => useMcpGrants(), { wrapper });
    await waitFor(() => expect(result.current.grants).toEqual([]));

    postGrantMock.mockResolvedValueOnce(grantProjects);
    await act(async () => {
      await result.current.grant("projects", 1);
    });

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "AI access granted",
        description: "Edit only in projects",
        variant: "info",
      }),
    );

    postGrantMock.mockResolvedValueOnce(grantProjectsUpgraded);
    await act(async () => {
      await result.current.grant("projects", 2);
    });

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "AI access upgraded",
        description: "Now full in projects",
        variant: "info",
      }),
    );
  });

  it("M5b: first-time Tier 2 grant uses 'Full in {path}' description", async () => {
    listGrantsMock.mockResolvedValue([]);

    const { result } = renderHook(() => useMcpGrants(), { wrapper });
    await waitFor(() => expect(result.current.grants).toEqual([]));

    postGrantMock.mockResolvedValueOnce(grantProjectsUpgraded);
    await act(async () => {
      await result.current.grant("projects", 2);
    });

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "AI access granted",
        description: "Full in projects",
        variant: "info",
      }),
    );
  });

  it("M6: downgrade Tier 2 → Tier 1 fires 'AI access changed'", async () => {
    listGrantsMock.mockResolvedValue([grantProjectsUpgraded]);

    const { result } = renderHook(() => useMcpGrants(), { wrapper });
    await waitFor(() =>
      expect(result.current.directLevelFor("projects")).toBe(2),
    );

    postGrantMock.mockResolvedValueOnce(grantProjects);
    await act(async () => {
      await result.current.grant("projects", 1);
    });

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "AI access changed",
        description: "Now edit only in projects",
        variant: "info",
      }),
    );
  });

  it("M7: revoke fires 'AI access revoked' with path as description", async () => {
    listGrantsMock.mockResolvedValue([grantProjects]);

    const { result } = renderHook(() => useMcpGrants(), { wrapper });
    await waitFor(() => expect(result.current.grants.length).toBe(1));

    deleteGrantMock.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.revoke("projects");
    });

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "AI access revoked",
        description: "projects",
        variant: "info",
      }),
    );
    expect(result.current.grants).toEqual([]);
  });

  it("M8: grant() failure emits 'Couldn't update AI access' toast", async () => {
    listGrantsMock.mockResolvedValue([]);

    const { result } = renderHook(() => useMcpGrants(), { wrapper });
    await waitFor(() => expect(result.current.grants).toEqual([]));

    postGrantMock.mockRejectedValueOnce(new Error("backend went away"));
    await act(async () => {
      await result.current.grant("projects", 1);
    });

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't update AI access",
        variant: "error",
      }),
    );
  });

  it("M9: three mounted consumers call the fetcher exactly once (D-11/D-14 fetch-once)", async () => {
    listGrantsMock.mockResolvedValue([grantProjects]);

    const { result: r1 } = renderHook(() => useMcpGrants(), { wrapper });
    const { result: r2 } = renderHook(() => useMcpGrants(), { wrapper });
    const { result: r3 } = renderHook(() => useMcpGrants(), { wrapper });

    await waitFor(() => {
      expect(r1.current.grants).toEqual([grantProjects]);
      expect(r2.current.grants).toEqual([grantProjects]);
      expect(r3.current.grants).toEqual([grantProjects]);
    });

    expect(listGrantsMock).toHaveBeenCalledTimes(1);
  });
});
