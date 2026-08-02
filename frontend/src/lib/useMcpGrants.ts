/**
 * useMcpGrants composes the shared mcpGrantsResource cache with POST/DELETE.
 * Mounting issues no request by itself.
 *
 * levelFor walks ancestors, matching how the backend resolves writes.
 * directLevelFor deliberately does not: the Sparkles indicator must show on the
 * folder the grant was attached to, not on every descendant.
 *
 * Toast copy is LOCKED — a Playwright spec asserts the exact strings.
 */

import { useCallback, useMemo } from "react";
import { useToast } from "../components/toast.utils";
import type { McpGrant } from "./useTreeStore";
import { mcpGrantsResource, postGrant, deleteGrant } from "./mcpGrantsApi";
import { publish, useResource } from "./resources";
import { __testing__ as resourcesTesting } from "./resources/createResource";

/**
 * Normalize a folder path to match backend canonicalization (NFC + lowercase).
 * The tree feed already provides canonical paths, but trimming slashes and
 * lowercasing is defense-in-depth against stale callers.
 */
function normPath(p: string): string {
  return p.toLowerCase().replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Result of `inheritedGrantOn(path)` — the first ANCESTOR folder that holds
 * a direct grant, or null. Skips the folder itself (use directLevelFor for
 * that). Drives the "Inherits AI access from {ancestor}" disabled menu item.
 */
export interface InheritedGrant {
  level: 1 | 2;
  ancestorPath: string;
}

export interface UseMcpGrantsResult {
  grants: McpGrant[];
  refresh: () => Promise<void>;
  grant: (folderPath: string, level: 1 | 2) => Promise<void>;
  revoke: (folderPath: string) => Promise<void>;
  levelFor: (folderPath: string) => 1 | 2 | null;
  directLevelFor: (folderPath: string) => 1 | 2 | null;
  /**
   * Returns the first ANCESTOR folder that holds a direct grant, or null.
   * The folder itself is NOT considered (use `directLevelFor` for that).
   */
  inheritedGrantOn: (folderPath: string) => InheritedGrant | null;
}

export function useMcpGrants(): UseMcpGrantsResult {
  const snapshot = useResource(mcpGrantsResource);
  // Memoized so `snapshot.data ?? []` doesn't allocate a new array identity
  // on every render when data is still undefined — that would otherwise
  // make every derived useCallback below think its deps changed each render.
  const grants = useMemo(() => snapshot.data ?? [], [snapshot.data]);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    await mcpGrantsResource.invalidate().catch(() => undefined);
  }, []);

  /**
   * levelFor — recursive ancestor walk. A grant on `projects/` covers
   * `projects/ai/draft.md`. Walk is bounded by the path's slash count
   * plus one root check.
   */
  const levelFor = useCallback(
    (folderPath: string): 1 | 2 | null => {
      const norm = normPath(folderPath);
      let cur = norm;
      while (cur && cur !== "." && cur !== "/") {
        const hit = grants.find((g) => g.folder_path === cur);
        if (hit) return hit.level;
        const idx = cur.lastIndexOf("/");
        if (idx < 0) break;
        cur = cur.slice(0, idx);
      }
      const root = grants.find(
        (g) => g.folder_path === "" || g.folder_path === ".",
      );
      return root ? root.level : null;
    },
    [grants],
  );

  /**
   * directLevelFor — grant attached to THIS folder only (no ancestor walk).
   * Drives the Sparkles indicator: renders only on the leaf where the grant
   * was attached, not on every descendant.
   */
  const directLevelFor = useCallback(
    (folderPath: string): 1 | 2 | null => {
      const norm = normPath(folderPath);
      const hit = grants.find((g) => g.folder_path === norm);
      return hit ? hit.level : null;
    },
    [grants],
  );

  /**
   * inheritedGrantOn — walks ancestor chain (skipping the folder itself)
   * and returns the first ancestor with a direct grant. Used by TreeRowMenu
   * to suppress the redundant "Grant AI access" submenu on descendants.
   */
  const inheritedGrantOn = useCallback(
    (folderPath: string): InheritedGrant | null => {
      const norm = normPath(folderPath);
      const firstSlash = norm.lastIndexOf("/");
      let cur = firstSlash < 0 ? "" : norm.slice(0, firstSlash);
      while (cur && cur !== "." && cur !== "/") {
        const hit = grants.find((g) => g.folder_path === cur);
        if (hit) return { level: hit.level, ancestorPath: cur };
        const idx = cur.lastIndexOf("/");
        if (idx < 0) break;
        cur = cur.slice(0, idx);
      }
      if (norm !== "" && norm !== ".") {
        const root = grants.find(
          (g) => g.folder_path === "" || g.folder_path === ".",
        );
        if (root) return { level: root.level, ancestorPath: "" };
      }
      return null;
    },
    [grants],
  );

  /**
   * grant — idempotent on the backend. The toast variant is computed from the
   * BEFORE state, so a same-level re-grant stays silent.
   *
   * Applied AFTER the POST resolves, not optimistically: the WS broadcast is
   * what converges the other tabs.
   */
  const grant = useCallback(
    async (folderPath: string, level: 1 | 2) => {
      const before = directLevelFor(folderPath);
      try {
        await mcpGrantsResource.mutate({
          request: () => postGrant(folderPath, level),
          commit: (live, g) => [
            ...(live ?? []).filter((x) => x.folder_path !== g.folder_path),
            g,
          ],
        });
        if (before === null) {
          toast({
            title: "AI access granted",
            description:
              level === 2 ? `Full in ${folderPath}` : `Edit only in ${folderPath}`,
            variant: "info",
          });
        } else if (level === 2 && before === 1) {
          toast({
            title: "AI access upgraded",
            description: `Now full in ${folderPath}`,
            variant: "info",
          });
        } else if (level === 1 && before === 2) {
          toast({
            title: "AI access changed",
            description: `Now edit only in ${folderPath}`,
            variant: "info",
          });
        }
      } catch (e) {
        toast({
          title: "Couldn't update AI access",
          description: String(e instanceof Error ? e.message : e),
          variant: "error",
        });
      }
    },
    [toast, directLevelFor],
  );

  const revoke = useCallback(
    async (folderPath: string) => {
      try {
        await mcpGrantsResource.mutate({
          request: () => deleteGrant(folderPath),
          commit: (live) => (live ?? []).filter((g) => g.folder_path !== folderPath),
        });
        toast({
          title: "AI access revoked",
          description: folderPath,
          variant: "info",
        });
      } catch (e) {
        toast({
          title: "Couldn't revoke AI access",
          description: String(e instanceof Error ? e.message : e),
          variant: "error",
        });
      }
    },
    [toast],
  );

  return {
    grants,
    refresh,
    grant,
    revoke,
    levelFor,
    directLevelFor,
    inheritedGrantOn,
  };
}

export const __testing__ = {
  getSubscriberCount: () => resourcesTesting.getSubscriberCount("mcpGrants"),
  simulateEvent: () => publish("mcp:grant_changed"),
};
