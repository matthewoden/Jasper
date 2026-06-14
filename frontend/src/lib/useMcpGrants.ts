/**
 * useMcpGrants — composes the mcpGrants store slice with GET/POST/DELETE
 * backend calls and a WS refresh subscription on `mcp:grant_changed`.
 *
 * Public surface:
 *   - grants:            current store slice (McpGrant[])
 *   - refresh():         re-fetch GET /mcp/grants
 *   - grant(path, lv):   POST /mcp/grants — emits LOCKED toast
 *   - revoke(path):      DELETE /mcp/grants?path=... — emits LOCKED toast
 *   - levelFor(path):    recursive ancestor walk (backend resolves writes the same way)
 *   - directLevelFor(path): grant on THIS folder only — drives the Sparkles
 *                        indicator on the leaf where the grant was attached,
 *                        not on every descendant (Confused Deputy mitigation).
 *
 * Toast copy (LOCKED — Playwright spec asserts against these strings):
 *   grant added:    "AI access granted"   / "Edit only in {path}" or "Full in {path}"
 *   grant upgraded: "AI access upgraded"  / "Now full in {path}"
 *   grant changed:  "AI access changed"   / "Now edit only in {path}"
 *   grant revoked:  "AI access revoked"   / "{path}"
 */

import { useCallback, useEffect } from "react";
import { useToast } from "../components/toast.utils";
import { useTreeStore, type McpGrant } from "./useTreeStore";
import { listGrants, postGrant, deleteGrant } from "./mcpGrantsApi";


const mcpGrantsSubscribers = new Set<() => void>();

/**
 * Called by useSessionSync when a `mcp:grant_changed` WS event arrives.
 * Iterates a snapshot of the subscriber set so mid-iteration
 * register/unregister doesn't cause a concurrent-mutation error.
 */
export function dispatchMcpGrantsEvent(): void {
  const snapshot = Array.from(mcpGrantsSubscribers);
  for (const fn of snapshot) fn();
}

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
  const grants = useTreeStore((s) => s.mcpGrants);
  const setGrants = useTreeStore((s) => s.setMcpGrants);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const g = await listGrants();
      setGrants(g);
    } catch {
      // Silent — preserve the existing slice so a transient backend hiccup
      // doesn't wipe the indicator UI.
    }
  }, [setGrants]);

  useEffect(() => {
    void refresh();
    mcpGrantsSubscribers.add(refresh);
    return () => {
      mcpGrantsSubscribers.delete(refresh);
    };
  }, [refresh]);

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
   * grant — POST /mcp/grants. Idempotent on the backend. Toast variant
   * is computed from the BEFORE state of the direct grant:
   *   - before === null              → "AI access granted"
   *   - before === 1 && level === 2  → "AI access upgraded"
   *   - before === 2 && level === 1  → "AI access changed"
   *   - same level                   → no toast (no-op confirm)
   *
   * Optimistic update keeps the indicator snappy; the WS broadcast
   * fires a refresh that converges to the same state.
   */
  const grant = useCallback(
    async (folderPath: string, level: 1 | 2) => {
      const before = directLevelFor(folderPath);
      try {
        const g = await postGrant(folderPath, level);
        const next = [
          ...grants.filter((x) => x.folder_path !== g.folder_path),
          g,
        ];
        setGrants(next);
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
    [grants, setGrants, toast, directLevelFor],
  );

  const revoke = useCallback(
    async (folderPath: string) => {
      try {
        await deleteGrant(folderPath);
        setGrants(grants.filter((g) => g.folder_path !== folderPath));
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
    [grants, setGrants, toast],
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
  getSubscriberCount: () => mcpGrantsSubscribers.size,
  simulateEvent: () => dispatchMcpGrantsEvent(),
};
