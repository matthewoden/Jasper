/**
 * useBacklinks — reactive hook reading the shared `backlinksResource` cache
 * (keyed, single-slot: only the active note's entry is retained).
 * Subscribing (mounting) never issues a network request by itself — only
 * the resource's own 0->1 subscriber transition and its declared WS events
 * (note:updated, note:created, links:rewritten) do. See backlinksApi.ts's
 * registration comment for the deliberate tags:rewritten exclusion.
 */

import { useMemo } from "react";
import { backlinksResource, type BacklinkRow } from "./backlinksApi";
import { publish, useResource } from "./resources";
import { __testing__ as resourcesTesting } from "./resources/createResource";

export type LinksEventType = "note:updated" | "note:created" | "links:rewritten";

export interface UseBacklinksResult {
  /** null when noteId is null; empty array when note has no backlinks. */
  backlinks: BacklinkRow[] | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * useBacklinks(noteId) — reads GET /api/v1/notes/{id}/backlinks via the
 * shared resource layer. Returns null backlinks when noteId is null. On
 * error, the layer's preserve-last-good-value policy retains the previous
 * backlinks rather than clearing them.
 */
export function useBacklinks(noteId: string | null): UseBacklinksResult {
  const resource = useMemo(
    () => (noteId ? backlinksResource.forKey(noteId) : null),
    [noteId],
  );
  const snapshot = useResource(resource);

  return {
    backlinks: noteId === null ? null : (snapshot.data ?? null),
    loading: snapshot.loading,
    error: snapshot.error,
    refresh: async () => {
      // Matches the pre-migration contract: refresh() never rejects — a
      // failed fetch surfaces via snapshot.error, not a thrown promise, so
      // callers don't need a try/catch around every refresh() call.
      if (resource) await resource.invalidate().catch(() => undefined);
    },
  };
}

export const __testing__ = {
  simulateEvent: (event: LinksEventType) => {
    publish(event);
  },
  getSubscriberCount: (noteId: string) =>
    resourcesTesting.getSubscriberCount(`backlinks::${noteId}`),
};
