/**
 * useTagBrowser — reactive tag list hook.
 *
 * Fetches GET /api/v1/tags on mount, exposes refresh() for manual refetch,
 * and reacts to `tags:updated` / `tags:rewritten` WS events.
 *
 * WS integration: module-level subscriber set that useSessionSync's dispatch
 * loop populates via dispatchTagEvent(). This avoids modifying useSessionSync's
 * signature while giving reactive updates. The same pattern is used by
 * useBacklinks for `links:rewritten` and `note:updated` events.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listTags, type TagWithCount } from "./tagsApi";


const tagEventSubscribers = new Set<() => void>();

type TagEventType = "tags:updated" | "tags:rewritten";

/**
 * Called by useSessionSync when a tags:updated or tags:rewritten WS event arrives.
 * Triggers all mounted useTagBrowser instances to refetch.
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
