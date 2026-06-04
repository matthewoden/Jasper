/**
 * Tests for useMcpGrants hook (Phase 8 Plan 08-10).
 *
 * Coverage:
 *   M1: mount triggers listGrants once; store populates with returned grants
 *   M2: WS event (simulateEvent) triggers refresh — listGrants called again
 *   M3: levelFor walks ancestors (grant on "projects" → level for
 *       "projects/ai/draft.md" resolves to that level)
 *   M4: directLevelFor returns null for descendants (grant on "projects"
 *       → directLevelFor("projects/ai") is null; directLevelFor("projects")
 *       returns the level)
 *   M5: grant Tier 1 then upgrade Tier 2 — toast titles "AI access granted"
 *       then "AI access upgraded"
 *   M6: downgrade Tier 2 → Tier 1 — toast title "AI access changed"
 *   M7: revoke — toast title "AI access revoked"
 *   M8: grant error — toast title "Couldn't update AI access"
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

const listGrantsMock = vi.fn();
const postGrantMock = vi.fn();
const deleteGrantMock = vi.fn();

vi.mock("./mcpGrantsApi", () => ({
  listGrants: (...args: unknown[]) => listGrantsMock(...args),
  postGrant: (...args: unknown[]) => postGrantMock(...args),
  deleteGrant: (...args: unknown[]) => deleteGrantMock(...args),
}));

// Spy on the toast API by capturing every enqueued toast through a
// ToastProvider wrapper. We mock useToast directly so we can read the
// toast() calls without depending on Radix's portal rendering.
const toastSpy = vi.fn();
vi.mock("../components/toast.utils", () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));

import { useTreeStore } from "./useTreeStore";
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
    useTreeStore.setState({ mcpGrants: [] });
  });

  it("M1: mount calls listGrants once and populates the store", async () => {
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

    // First grant — Tier 1 → "AI access granted"
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

    // Upgrade — Tier 2 → "AI access upgraded"
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
    // Pre-seed the store with a Tier 2 grant so the BEFORE state is 2.
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
});
