/**
 * useTagBrowser — reactive tag list hook.
 *
 * Mirrors the useFileTree pattern:
 *   - Fetches GET /api/v1/tags on mount via listTags()
 *   - Exposes refresh() to manually refetch
 *   - Reacts to `tags:updated` and `tags:rewritten` WS events by refetching
 *
 * WS integration strategy: module-level subscriber sets (one per event type)
 * that App.tsx populates when those events fire from useSessionSync's
 * dispatch loop. This avoids modifying useSessionSync's signature while
 * giving useTagBrowser reactive updates.
 *
 * App.tsx integration site (for Plan 06-11 reference):
 *   const { dispatchTagsUpdated, dispatchTagsRewritten } = useTagBrowserEvents();
 *   // Call these from useSessionSync's "tags:updated" / "tags:rewritten" branches.
 *
 * The same useSessionSync integration pattern will be reused by useBacklinks
 * (Plan 06-11) for `links:rewritten` and `note:updated` events.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listTags, type TagWithCount } from "./tagsApi";

// ────────────────────────────────────────────────────────────────────────────
// Module-level subscriber registry — mirrors useFileTree's treeFetchSubscribers.
//
// Each mounted useTagBrowser instance registers its fetchTags callback here.
// When a WS event fires, App.tsx calls dispatchTagEvent("tags:updated") or
// dispatchTagEvent("tags:rewritten"), which iterates the set and triggers
// each subscriber to refetch.
// ────────────────────────────────────────────────────────────────────────────
const tagEventSubscribers = new Set<() => void>();

type TagEventType = "tags:updated" | "tags:rewritten";

/**
 * Called by App.tsx (or useSessionSync integration) when a tags:updated or
 * tags:rewritten WS event arrives. Triggers all mounted useTagBrowser
 * instances to refetch.
 *
 * This is the integration site for Plan 06-11's useBacklinks pattern:
 * import { dispatchTagEvent } from "./useTagBrowser" and call it from
 * useSessionSync's WS message handler.
 */
export function dispatchTagEvent(
  // event type is received from WS envelope; kept as a parameter so callers
  // can pass tags:updated or tags:rewritten without branching logic here.
  // The distinction between the two event types doesn't change behavior
  // (both trigger a full refetch) — the parameter is part of the public API
  // contract for caller clarity.
  event: TagEventType,
): void {
  // Suppress unused-var lint: the event type is part of the public contract
  // so callers can pass it explicitly; we don't branch on it here since both
  // event types trigger the same refetch action.
  void event;
  const snapshot = Array.from(tagEventSubscribers);
  for (const fn of snapshot) {
    fn();
  }
}

export interface UseTagBrowserResult {
  tags: TagWithCount[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export function useTagBrowser(): UseTagBrowserResult {
  const [tags, setTags] = useState<TagWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const cancelled = useRef(false);
  // Keep a stable ref to the previous tags so we can preserve them on error
  // (per U6 / useFileTree precedent — don't clear on error).
  const tagsRef = useRef<TagWithCount[]>([]);

  const fetchTags = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listTags();
      if (cancelled.current) return;
      tagsRef.current = result;
      setTags(result);
      setError(null);
      setLoading(false);
    } catch (e) {
      if (cancelled.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      // Preserve previous data on error (per useFileTree precedent)
      setTags(tagsRef.current);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void fetchTags();

    // Register this instance's refresh callback in the module-level subscriber
    // set so WS events from App.tsx reach this hook instance.
    const subscriber = () => {
      void fetchTags();
    };
    tagEventSubscribers.add(subscriber);

    return () => {
      cancelled.current = true;
      tagEventSubscribers.delete(subscriber);
    };
  }, [fetchTags]);

  const refresh = useCallback(async () => {
    cancelled.current = false;
    await fetchTags();
  }, [fetchTags]);

  return { tags, loading, error, refresh };
}

// ────────────────────────────────────────────────────────────────────────────
// Test helpers — exported under __testing__ namespace, not part of the
// public surface. Consumers should use refresh() from useTagBrowser().
// ────────────────────────────────────────────────────────────────────────────
export const __testing__ = {
  simulateEvent: (event: TagEventType) => {
    dispatchTagEvent(event);
  },
  getSubscriberCount: () => tagEventSubscribers.size,
};
