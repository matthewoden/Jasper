/**
 * useFileTree — single-flight GET /tree on mount, with manual `refresh()`
 * and optimistic `mutate(recipe)` for in-tree updates that should NOT
 * re-fetch (e.g., drag-drop applies the new layout immediately).
 *
 * Locked signature (UI-SPEC §Forward-compat assert #1 — Phase 4 will swap
 * the data source to WebSocket-driven invalidation without changing the
 * public shape):
 *
 *   useFileTree(): {
 *     tree:    Tree | null   // null until first fetch resolves
 *     loading: boolean       // true during in-flight fetch
 *     error:   Error | null  // last error from getTree()
 *     refresh: () => Promise<void>                        // re-fetch
 *     mutate:  (recipe: (cur: Tree) => Tree) => void      // optimistic update
 *   }
 *
 * After every successful fetch (mount + refresh), the hook walks the
 * response and calls pruneStaleTreeState(folderPaths, noteIds) so any
 * localStorage entries for nodes that no longer exist get silently
 * dropped (UI-SPEC §State persistence — "Stale entries are silently
 * dropped on hydration").
 *
 * Plan 03-09 (Gap 1) — broadcast refresh: refresh() now triggers EVERY
 * mounted useFileTree instance to re-fetch, not just the one whose
 * `refresh` was invoked. This is required because useTreeMutations
 * calls useFileTree() to get its own refresh handle (per Plan 03-09's
 * "lift the contract into the data layer" decision); without
 * broadcasting, only the mutator's instance would see the new tree —
 * the FileTree-rendered instance would stay stale, which IS the bug
 * Gap 1 reported.
 *
 * Implementation: a module-level Set<() => Promise<void>> of
 * subscriber-fetch callbacks. Each useFileTree instance registers its
 * fetchTree on mount and unregisters on unmount. refresh() iterates
 * the Set and awaits all of them (instances that have unmounted
 * silently no-op via the cancelled flag — same pattern as the
 * existing StrictMode-safety guard).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { getTree, type Tree, type TreeNode } from "./treeApi";
import { pruneStaleTreeState } from "./useTreeStore";

// Module-level subscriber registry — one entry per mounted useFileTree
// instance. refresh() (from any instance) iterates the Set and calls
// each registered fetcher so every UI surface that reads useFileTree
// re-fetches in lockstep. Phase 4 will swap this for a WebSocket
// broadcast, but the public API (refresh: () => Promise<void>) stays
// the same.
const treeFetchSubscribers = new Set<() => Promise<void>>();

async function broadcastRefresh(): Promise<void> {
  // Snapshot first — a subscriber whose effect cleanup runs during
  // refresh might unregister itself mid-iteration. Iterating a
  // snapshot avoids missing or double-firing.
  const snapshot = Array.from(treeFetchSubscribers);
  await Promise.all(snapshot.map((fn) => fn()));
}

export interface UseFileTreeResult {
  tree: Tree | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  mutate: (recipe: (current: Tree) => Tree) => void;
}

/**
 * Walk the tree once, collecting every folder path and every note id.
 * Used by useFileTree to prune stale entries from useTreeStore after a
 * fresh fetch lands.
 */
export function walkTreeCollect(tree: Tree): {
  folders: Set<string>;
  notes: Set<string>;
} {
  const folders = new Set<string>();
  const notes = new Set<string>();
  const visit = (node: TreeNode): void => {
    if (node.kind === "folder") {
      folders.add(node.path);
      if (node.children) {
        for (const child of node.children) visit(child);
      }
    } else {
      notes.add(node.id);
    }
  };
  for (const node of tree.root) visit(node);
  return { folders, notes };
}

export function useFileTree(): UseFileTreeResult {
  const [tree, setTree] = useState<Tree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const cancelled = useRef(false);

  const fetchTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: respErr } = await getTree();
      if (cancelled.current) return;
      if (respErr) {
        setError(new Error(respErr.message));
        setLoading(false);
        return;
      }
      if (data) {
        setTree(data);
        const { folders, notes } = walkTreeCollect(data);
        pruneStaleTreeState(folders, notes);
      }
      setLoading(false);
    } catch (e) {
      if (cancelled.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      setLoading(false);
    }
  }, []);

  // Single-flight on mount. The cancelled flag mirrors useMigrationStatus's
  // pattern (CR-04): under React 19 StrictMode the effect runs twice; the
  // resolution from the first (cancelled) run is ignored so we don't
  // double-set state.
  //
  // We also register/unregister this instance's fetchTree in the
  // module-level subscriber Set so refresh() from ANY instance
  // (notably the one inside useTreeMutations — Plan 03-09) triggers
  // a re-fetch on this instance too.
  useEffect(() => {
    cancelled.current = false;
    void fetchTree();
    treeFetchSubscribers.add(fetchTree);
    return () => {
      cancelled.current = true;
      treeFetchSubscribers.delete(fetchTree);
    };
  }, [fetchTree]);

  const refresh = useCallback(async () => {
    // Reset cancelled so the local instance's setState calls land on
    // its own fetch path; broadcastRefresh fires every other
    // subscriber too (Plan 03-09 — Gap 1 broadcast contract).
    cancelled.current = false;
    await broadcastRefresh();
  }, []);

  const mutate = useCallback((recipe: (current: Tree) => Tree) => {
    setTree((cur) => (cur ? recipe(cur) : cur));
  }, []);

  return { tree, loading, error, refresh, mutate };
}
