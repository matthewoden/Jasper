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

// UX-14: leading-edge fire + trailing-window coalescer for GET /tree.
//
// Layered behavior:
//   1. Concurrent calls share the same in-flight promise (single-flight).
//   2. The FIRST call after a quiet period fires immediately.
//   3. Any call arriving within COALESCE_TAIL_MS of the last fetch's
//      resolution folds into a single trailing fetch scheduled at the
//      end of the window — instead of firing back-to-back getTree
//      requests as broadcasts arrive in close succession (e.g., the
//      mutation's awaited refresh + the server's WS broadcast for the
//      same op landing ~10ms later).
//
// Pitfall 8 (RESEARCH §Pitfall 8): the .finally() resets the slot
// whether the call succeeded or rejected. Without that, a single
// network failure would poison the slot forever and every subsequent
// refresh would re-serve the rejected promise. Rejections must
// propagate to ALL awaiters (in-flight, in-trailing, future).
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
  // 1. Concurrent fan-in: share the same in-flight promise.
  if (inFlightTreePromise !== null) return inFlightTreePromise;

  // 2. Trailing-window: if another fetch JUST resolved, defer this
  //    one to the end of the window so any further calls can fold in.
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

  // 3. Cold start: fire immediately. lastResolvedAt updates inside
  //    startInFlight's .finally so the next call's window calculation
  //    sees the freshest timestamp.
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

// Module-level subscriber registry — one entry per mounted useFileTree
// instance. refresh() (from any instance) iterates the Set and calls
// each registered fetcher so every UI surface that reads useFileTree
// re-fetches in lockstep. Phase 4 will swap this for a WebSocket
// broadcast, but the public API (refresh: () => Promise<void>) stays
// the same.
const treeFetchSubscribers = new Set<() => Promise<void>>();

// UAT-2 R1-2/R1-3 (Plan 07-23 Fix A): eager boot fetch.
//
// Rationale: `useFileTree` previously started its first GET /tree fetch only
// when a consumer hook mounted inside the React tree. On a fresh page load,
// the user can press Cmd+O (quick-switcher) or Cmd+P (command palette) before
// any consuming component has mounted — or the first mount's fetch is still
// in-flight — so `useQuickSwitcher` receives `tree === null` and renders an
// empty list. This is the root cause of UAT-2 R1-2/R1-3.
//
// Fix: fire coalescedGetTree() at module-import time so the server response
// is already in-flight (or cached) by the time the first consumer hook mounts.
// coalescedGetTree single-flights concurrent calls, so this adds exactly one
// extra GET /tree request at startup; subsequent hook mounts share the same
// in-flight promise (or find lastResolvedAt > 0 and fold into the trailing
// window). No double-fetch regression.
//
// SSR guard: if `window` is undefined (e.g., test environments that run in
// Node without a DOM), skip the boot fetch so server-side code is unaffected.
// In vitest (jsdom), `window` is defined but tests that re-import the module
// via vi.resetModules() will see a fresh bootFetchStarted = false, which is
// exactly what the UFT-eager-boot test exercises.
let bootFetchStarted = false;
function startBootFetch(): void {
  if (bootFetchStarted) return;
  if (typeof window === "undefined") return; // SSR / non-browser safety
  bootFetchStarted = true;
  // fire-and-forget; the promise result lands in the module-level coalescer
  // cache and the first subscribing useFileTree instance will pick it up.
  // Silently swallow any rejection — the hook's own useEffect will surface
  // errors through the normal error state on its first render cycle.
  coalescedGetTree().catch(() => undefined);
}
// Kick off the boot fetch immediately at module import.
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
    } else if (node.kind === "note") {
      // Plan 07-26: "file" kind has no id; skip (file nodes are not tracked in stale-state pruning).
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

// UX-14: exported for tests only. The coalescer wrapper around
// getTree() — see the module-level inFlightTreePromise comment above.
// `__resetCoalescer` clears the trailing-window state so unit tests
// can assert leading-edge behavior without coupling to ordering of
// other tests in the same module.
// Not part of the public surface; consumers should use refresh() from
// the useFileTree hook instead.
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
