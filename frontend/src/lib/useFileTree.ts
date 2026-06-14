/**
 * useFileTree — single-flight GET /tree on mount, with manual `refresh()`
 * and optimistic `mutate(recipe)` for in-tree updates that skip a round-trip.
 *
 * Public shape:
 *   useFileTree(): {
 *     tree:    Tree | null
 *     loading: boolean
 *     error:   Error | null
 *     refresh: () => Promise<void>
 *     mutate:  (recipe: (cur: Tree) => Tree) => void
 *   }
 *
 * After every successful fetch, the hook calls pruneStaleTreeState() to
 * silently drop localStorage entries for nodes that no longer exist.
 *
 * Broadcast refresh: refresh() triggers every mounted useFileTree instance,
 * not just the one whose `refresh` was called. Without broadcasting, a
 * mutation caller's instance would refresh but the rendered FileTree instance
 * would stay stale. Module-level Set of subscriber callbacks, registered on
 * mount and removed on unmount.
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
 * non-display callers (mutations, WS event handlers) can refresh the tree
 * without instantiating their own useFileTree subscriber. Adding a subscriber
 * per non-display caller inflates the broadcast Set by N (one per TreeRow's
 * useTreeMutations), which collapses the single-flight coalescer on any
 * parent re-render. Display surfaces still call useFileTree() to render tree state.
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

/** Walk the tree collecting every folder path and note id. */
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
    // "file" kind nodes have no note id and are not tracked here.
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
