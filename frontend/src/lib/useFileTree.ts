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

import { getTree, type ApiError, type Tree, type TreeNode } from "./treeApi";
import { pruneStaleTreeState } from "./useTreeStore";


const COALESCE_TAIL_MS = 100;
let inFlightTreePromise: Promise<{ data?: Tree; error?: ApiError }> | null =
  null;
let lastResolvedAt = 0;
let pendingTrailingPromise: Promise<{ data?: Tree; error?: ApiError }> | null =
  null;
let pendingTrailingResolve:
  | ((v: { data?: Tree; error?: ApiError }) => void)
  | null = null;
let pendingTrailingReject: ((e: unknown) => void) | null = null;
let pendingTrailingTimer: ReturnType<typeof setTimeout> | null = null;

function startInFlight(): Promise<{ data?: Tree; error?: ApiError }> {
  inFlightTreePromise = getTree().finally(() => {
    inFlightTreePromise = null;
    lastResolvedAt = Date.now();
  });
  return inFlightTreePromise;
}

async function coalescedGetTree(): Promise<{ data?: Tree; error?: ApiError }> {
  if (inFlightTreePromise !== null) return inFlightTreePromise;

  const elapsed = Date.now() - lastResolvedAt;
  if (lastResolvedAt > 0 && elapsed < COALESCE_TAIL_MS) {
    if (pendingTrailingPromise === null) {
      pendingTrailingPromise = new Promise((resolve, reject) => {
        pendingTrailingResolve = resolve;
        pendingTrailingReject = reject;
      });
    }
    if (pendingTrailingTimer !== null) clearTimeout(pendingTrailingTimer);
    pendingTrailingTimer = setTimeout(
      flushTrailing,
      COALESCE_TAIL_MS - elapsed,
    );
    return pendingTrailingPromise;
  }

  return startInFlight();
}

function flushTrailing(): void {
  if (pendingTrailingTimer !== null) {
    clearTimeout(pendingTrailingTimer);
    pendingTrailingTimer = null;
  }
  const resolve = pendingTrailingResolve;
  const reject = pendingTrailingReject;
  pendingTrailingResolve = null;
  pendingTrailingReject = null;
  pendingTrailingPromise = null;
  if (resolve === null || reject === null) return;
  startInFlight().then(resolve, reject);
}


const treeFetchSubscribers = new Set<() => Promise<void>>();


let bootFetchStarted = false;
function startBootFetch(): void {
  if (bootFetchStarted) return;
  if (typeof window === "undefined") return;
  bootFetchStarted = true;
  coalescedGetTree().catch(() => undefined);
}

startBootFetch();

/**
 * Trigger every mounted useFileTree instance to re-fetch. Exported so
 * non-display callers (mutations, WS event handlers) can refresh the
 * tree WITHOUT instantiating their own useFileTree subscriber. Adding
 * a subscriber per non-display caller used to inflate the broadcast Set
 * by N (one per TreeRow's useTreeMutations) which collapsed the
 * single-flight coalescer to nothing as soon as React re-mounted any
 * one of those rows on a parent re-render — see the sidebar-resize
 * regression fixed 2026-05-09. Display surfaces (Sidebar, FileTree,
 * EditorPane) still call useFileTree() because they need to render the
 * tree state.
 */
export async function broadcastRefresh(): Promise<void> {
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
    } else if (node.kind === "note") {
      notes.add(node.id);
    }
    // Plan 07-26: "file" kind nodes are not tracked (no note id).
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
      const { data, error: respErr } = await coalescedGetTree();
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
    cancelled.current = false;
    await broadcastRefresh();
  }, []);

  const mutate = useCallback((recipe: (current: Tree) => Tree) => {
    setTree((cur) => (cur ? recipe(cur) : cur));
  }, []);

  return { tree, loading, error, refresh, mutate };
}


function __resetCoalescer(): void {
  if (pendingTrailingTimer !== null) {
    clearTimeout(pendingTrailingTimer);
    pendingTrailingTimer = null;
  }
  inFlightTreePromise = null;
  lastResolvedAt = 0;
  pendingTrailingPromise = null;
  pendingTrailingResolve = null;
  pendingTrailingReject = null;
}
export const __testing__ = { coalescedGetTree, __resetCoalescer };
