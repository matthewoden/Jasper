/**
 * useMcpGrants — Phase 8 Plan 08-10 (D-55, MCP-01, MCP-02, D-57).
 *
 * Hook that composes the `mcpGrants` slice of useTreeStore with the
 * GET/POST/DELETE backend (mcpGrantsApi.ts) and a WS refresh subscription
 * on `mcp:grant_changed` (D-57, broadcast by 08-08 backend after every
 * grant mutation). All MCP grant UI surfaces (TreeRowMenu submenu,
 * McpGrantIndicator Sparkles icon, future surfaces) read from this hook.
 *
 * Public surface:
 *   - grants:           the current store slice (McpGrant[])
 *   - refresh():        re-fetch GET /mcp/grants and replace the slice
 *   - grant(path, lv):  POST /mcp/grants — emits LOCKED two-line toast
 *   - revoke(path):     DELETE /mcp/grants?path=... — emits LOCKED toast
 *   - levelFor(path):   recursive lookup — walks ancestors, mirrors D-18
 *                       (backend resolves writes the same way)
 *   - directLevelFor(path): grant attached to THIS folder (no ancestor
 *                       walk) — drives the Sparkles indicator render,
 *                       which per UI-SPEC §Surface 3 shows ONLY on the
 *                       leaf where the grant was attached (T-08-48
 *                       mitigation — Confused Deputy on child folders).
 *
 * WS refresh pattern: a module-level Set of subscriber callbacks
 * (mirrors useTagBrowser.ts's `tagEventSubscribers`). useSessionSync
 * calls `dispatchMcpGrantsEvent()` from its `mcp:grant_changed` branch,
 * which iterates the set and triggers each mounted hook to refetch.
 *
 * Toast contract (LOCKED — UI-SPEC §Copywriting "MCP Grant AI access
 * Submenu" lines 180-194 — 08-15 Playwright spec asserts against this):
 *   grant added:    title="AI access granted"   description="Edit only in {path}" or "Full in {path}"
 *   grant upgraded: title="AI access upgraded"  description="Now full in {path}"
 *   grant changed:  title="AI access changed"   description="Now edit only in {path}"
 *   grant revoked:  title="AI access revoked"   description="{path}"
 */

import { useCallback, useEffect } from "react";
import { useToast } from "../components/Toast";
import { useTreeStore, type McpGrant } from "./useTreeStore";
import { listGrants, postGrant, deleteGrant } from "./mcpGrantsApi";

// ────────────────────────────────────────────────────────────────────────────
// Module-level subscriber registry — mirrors useTagBrowser's
// tagEventSubscribers. useSessionSync calls dispatchMcpGrantsEvent() from
// the `mcp:grant_changed` WS branch; each mounted hook's refresh callback
// is invoked so the indicator updates everywhere.
// ────────────────────────────────────────────────────────────────────────────
const mcpGrantsSubscribers = new Set<() => void>();

/**
 * Called by useSessionSync when a `mcp:grant_changed` WS event arrives.
 * Iterates a defensive snapshot of the subscriber set so callbacks that
 * register/unregister mid-iteration don't trip a concurrent-mutation
 * error (matches useTagBrowser's dispatchTagEvent precedent).
 */
export function dispatchMcpGrantsEvent(): void {
  const snapshot = Array.from(mcpGrantsSubscribers);
  for (const fn of snapshot) fn();
}

/**
 * Normalize a folder path the same way the backend canonicalizes paths
 * (DATA-11: NFC + lowercase). The frontend already operates on canonical
 * paths from the tree feed, but trim slashes + lowercase as defense in
 * depth (a hand-built tree node from an older code path could leak in
 * with a leading or trailing slash).
 */
function normPath(p: string): string {
  return p.toLowerCase().replace(/^\/+/, "").replace(/\/+$/, "");
}

export interface UseMcpGrantsResult {
  grants: McpGrant[];
  refresh: () => Promise<void>;
  grant: (folderPath: string, level: 1 | 2) => Promise<void>;
  revoke: (folderPath: string) => Promise<void>;
  levelFor: (folderPath: string) => 1 | 2 | null;
  directLevelFor: (folderPath: string) => 1 | 2 | null;
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
      // Silent — preserve the existing slice so a transient backend
      // hiccup doesn't wipe the indicator UI (matches useTagBrowser's
      // "preserve previous data on error" precedent).
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
   * levelFor — recursive ancestor walk. Mirrors D-18 backend resolution:
   * a grant on `projects/` covers `projects/ai/draft.md`. Used by code
   * paths that need to know whether the AI can write to a given file
   * (e.g. a future "AI can write here" surface in the editor).
   *
   * The walk is intentionally bounded by the path's slash count + one
   * (the root check), so a deeply-nested path collapses to a constant
   * number of grants-array scans relative to the grants count.
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
      // Root-level grant: backends represent the vault root as either
      // "" or "." depending on canonicalization context; check both.
      const root = grants.find(
        (g) => g.folder_path === "" || g.folder_path === ".",
      );
      return root ? root.level : null;
    },
    [grants],
  );

  /**
   * directLevelFor — grant attached to THIS folder only (no ancestor
   * walk). Drives the Sparkles indicator per UI-SPEC §Surface 3:
   * "indicator renders on the LEAF where the grant was attached, not on
   * every recursive descendant" (T-08-48 mitigation).
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
   * grant — POST /mcp/grants. Idempotent on the backend; the frontend
   * computes the toast variant from the BEFORE state of the direct
   * grant on this folder:
   *   - before === null:              "AI access granted" (added)
   *   - before === 1 && level === 2:  "AI access upgraded"
   *   - before === 2 && level === 1:  "AI access changed" (downgrade)
   *   - otherwise (same level):       no toast (no-op user feedback —
   *     the click was a confirm of the existing state)
   *
   * Local optimistic update (replace the row in the slice) keeps the
   * indicator UI snappy; the WS `mcp:grant_changed` broadcast will
   * fire a refresh shortly after that produces the same state (so the
   * optimistic update is consistent with the broadcast).
   */
  const grant = useCallback(
    async (folderPath: string, level: 1 | 2) => {
      const before = directLevelFor(folderPath);
      try {
        const g = await postGrant(folderPath, level);
        // Replace any existing row for the same folder_path; then append
        // the new/upgraded row.
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
        // before === level (no-op confirm) → no toast.
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

  return { grants, refresh, grant, revoke, levelFor, directLevelFor };
}

// ────────────────────────────────────────────────────────────────────────────
// Test helpers — exported under __testing__ namespace, not part of the
// public surface. Mirrors useTagBrowser's __testing__ export.
// ────────────────────────────────────────────────────────────────────────────
export const __testing__ = {
  getSubscriberCount: () => mcpGrantsSubscribers.size,
  simulateEvent: () => dispatchMcpGrantsEvent(),
};
