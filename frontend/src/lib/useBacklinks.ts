/**
 * useBacklinks — reactive hook that fetches and refreshes backlinks for the
 * currently open note.
 *
 * Plan 06-11 / LINKS-08 / D-27..D-32.
 *
 * WS integration strategy: module-level subscriber Set (mirrors useTagBrowser
 * and useFileTree patterns). When any of the relevant WS events arrive,
 * useSessionSync calls dispatchLinksEvent() which fan-outs to all mounted
 * useBacklinks instances. This avoids modifying useSessionSync's signature
 * while keeping the hook reactive.
 *
 * Events that trigger a refetch (D-31):
 *   - note:updated  — a save anywhere could change the [[...]] content
 *   - note:created  — new note might link to the current one
 *   - links:rewritten — a rename propagated link text changes
 *
 * tags:rewritten is intentionally excluded: tag rewrites do not affect
 * [[wiki-link]] content and including it would over-trigger fetches.
 * (D-31 precision clarification — documented here.)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getNoteBacklinks, type BacklinkRow } from "./backlinksApi";

// ────────────────────────────────────────────────────────────────────────────
// Module-level subscriber registry — mirrors useTagBrowser/useFileTree.
//
// Each mounted useBacklinks instance registers its fetchBacklinks callback.
// dispatchLinksEvent() iterates the Set on the relevant WS events.
// ────────────────────────────────────────────────────────────────────────────
// Exported so useTagsForNote (Plan 07-35) can subscribe to the same WS events
// without duplicating the subscriber-set infrastructure. Both hooks refetch on
// note:updated / note:created / links:rewritten — sharing one Set is correct.
export const linksEventSubscribers = new Set<() => void>();

export type LinksEventType = "note:updated" | "note:created" | "links:rewritten";

/**
 * Called by useSessionSync (via the switch over WSEnvelope.event) when a
 * note:updated, note:created, or links:rewritten event arrives. Triggers
 * all mounted useBacklinks instances to refetch.
 */
export function dispatchLinksEvent(event: LinksEventType): void {
  // event type is part of the public API so callers can pass it explicitly.
  // Both "note:updated" and "note:created" trigger the same refetch.
  void event;
  const snapshot = Array.from(linksEventSubscribers);
  for (const fn of snapshot) {
    fn();
  }
}

export interface UseBacklinksResult {
  /** null when noteId is null; empty array when note has no backlinks. */
  backlinks: BacklinkRow[] | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * useBacklinks(noteId) — fetches GET /api/v1/notes/{id}/backlinks on mount and
 * whenever a relevant WS event fires. Returns null backlinks when noteId is null.
 *
 * Data retention on error: previous backlinks are preserved (same as useFileTree
 * and useTagBrowser; surfaces the error without clearing the stale rows).
 */
export function useBacklinks(noteId: string | null): UseBacklinksResult {
  const [backlinks, setBacklinks] = useState<BacklinkRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const cancelled = useRef(false);
  // Retain previous data on error (mirrors useTagBrowser precedent).
  const backlinksRef = useRef<BacklinkRow[] | null>(null);
  // Keep noteId in a ref so the subscriber closure always reads the current value.
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;

  const fetchBacklinks = useCallback(async () => {
    const id = noteIdRef.current;
    if (!id) {
      setBacklinks(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const result = await getNoteBacklinks(id);
      if (cancelled.current) return;
      backlinksRef.current = result;
      setBacklinks(result);
      setError(null);
      setLoading(false);
    } catch (e) {
      if (cancelled.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      // Preserve previous data on error (D-30 / useTagBrowser precedent).
      setBacklinks(backlinksRef.current);
      setLoading(false);
    }
  }, []); // fetchBacklinks has no deps — reads noteIdRef.current at call time.

  // Re-run on noteId change.
  useEffect(() => {
    cancelled.current = false;

    if (noteId === null) {
      setBacklinks(null);
      setLoading(false);
      setError(null);
      backlinksRef.current = null;
    } else {
      void fetchBacklinks();
    }

    // Register for WS fan-out.
    const subscriber = () => {
      if (noteIdRef.current) void fetchBacklinks();
    };
    linksEventSubscribers.add(subscriber);

    return () => {
      cancelled.current = true;
      linksEventSubscribers.delete(subscriber);
    };
    // fetchBacklinks is stable (no deps) — safe to include.
  }, [noteId, fetchBacklinks]);

  const refresh = useCallback(async () => {
    cancelled.current = false;
    await fetchBacklinks();
  }, [fetchBacklinks]);

  return { backlinks, loading, error, refresh };
}

// ────────────────────────────────────────────────────────────────────────────
// Test helpers — mirrors useTagBrowser.__testing__.
// ────────────────────────────────────────────────────────────────────────────
export const __testing__ = {
  simulateEvent: (event: LinksEventType) => {
    dispatchLinksEvent(event);
  },
  getSubscriberCount: () => linksEventSubscribers.size,
};
