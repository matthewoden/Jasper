/**
 * useBacklinks — reactive hook that fetches and refreshes backlinks for the
 * currently open note.
 *
 * WS integration: module-level subscriber Set mirrors the useTagBrowser /
 * useFileTree pattern. useSessionSync calls dispatchLinksEvent(), which
 * fans out to all mounted instances without modifying useSessionSync's signature.
 *
 * Events that trigger a refetch:
 *   - note:updated   — a save anywhere could change [[...]] content
 *   - note:created   — a new note might link to the current one
 *   - links:rewritten — a rename propagated link text changes
 *
 * tags:rewritten is intentionally excluded: tag rewrites do not affect
 * [[wiki-link]] content and would over-trigger fetches.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getNoteBacklinks, type BacklinkRow } from "./backlinksApi";


export const linksEventSubscribers = new Set<() => void>();

export type LinksEventType = "note:updated" | "note:created" | "links:rewritten";

/**
 * Called by useSessionSync when a note:updated, note:created, or
 * links:rewritten WS event arrives. Triggers all mounted instances to refetch.
 */
export function dispatchLinksEvent(event: LinksEventType): void {
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
 * On error, preserves the previous backlinks rather than clearing them.
 */
export function useBacklinks(noteId: string | null): UseBacklinksResult {
  const [backlinks, setBacklinks] = useState<BacklinkRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const cancelled = useRef(false);
  const backlinksRef = useRef<BacklinkRow[] | null>(null);
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
      setBacklinks(backlinksRef.current);
      setLoading(false);
    }
  }, []);

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

    const subscriber = () => {
      if (noteIdRef.current) void fetchBacklinks();
    };
    linksEventSubscribers.add(subscriber);

    return () => {
      cancelled.current = true;
      linksEventSubscribers.delete(subscriber);
    };
  }, [noteId, fetchBacklinks]);

  const refresh = useCallback(async () => {
    cancelled.current = false;
    await fetchBacklinks();
  }, [fetchBacklinks]);

  return { backlinks, loading, error, refresh };
}


export const __testing__ = {
  simulateEvent: (event: LinksEventType) => {
    dispatchLinksEvent(event);
  },
  getSubscriberCount: () => linksEventSubscribers.size,
};
