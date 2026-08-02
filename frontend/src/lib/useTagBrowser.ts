/**
 * useTagBrowser reads the shared tagsResource. No per-instance copy, so split
 * view no longer duplicates the list or the fetch.
 *
 * The resource declares its own invalidatedBy events, so this hook needs no
 * subscriber set of its own.
 */

import { publish, useResource } from "./resources";
import { __testing__ as resourcesTesting } from "./resources/createResource";
import { tagsResource, type TagWithCount } from "./tagsApi";

type TagEventType = "tags:updated" | "tags:rewritten";

export interface UseTagBrowserResult {
  tags: TagWithCount[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export function useTagBrowser(): UseTagBrowserResult {
  const snapshot = useResource(tagsResource);

  return {
    tags: snapshot.data ?? [],
    loading: snapshot.loading,
    // Unlike grants, useTagBrowser surfaces its error to the caller rather
    // than swallowing it — preserve-last-good-value for `tags` is the
    // resource layer's job, but the error itself stays visible.
    error: snapshot.error,
    refresh: async () => {
      await tagsResource.invalidate();
    },
  };
}

export const __testing__ = {
  simulateEvent: (event: TagEventType) => {
    publish(event);
  },
  getSubscriberCount: () => resourcesTesting.getSubscriberCount("tags"),
};
