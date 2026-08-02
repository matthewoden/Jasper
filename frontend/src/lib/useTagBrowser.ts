/**
 * useTagBrowser — reactive tag list hook, reading the shared `tagsResource`
 * cache. There is no per-instance copy of the tag list any
 * more: every mounted `MarkdownEditor` pane and `RightRailTagsPanel` reads
 * the SAME cache entry, so split view no longer duplicates the list or the
 * fetch.
 *
 * WS integration: `tagsResource` declares `invalidatedBy: ["tags:updated",
 * "tags:rewritten"]` at registration time (mcpGrantsApi.ts's sibling
 * pattern) — the resource layer subscribes to the event bus itself, so this
 * hook no longer needs a module-level subscriber Set or a dispatch function.
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
