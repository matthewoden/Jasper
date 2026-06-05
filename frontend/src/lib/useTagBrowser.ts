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
  event: TagEventType,
): void {
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
      setTags(tagsRef.current);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void fetchTags();

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


export const __testing__ = {
  simulateEvent: (event: TagEventType) => {
    dispatchTagEvent(event);
  },
  getSubscriberCount: () => tagEventSubscribers.size,
};
