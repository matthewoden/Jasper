/**
 * Module-level WS event pub/sub. Replaces the five per-hook `dispatch*Event`
 * functions (useMcpGrants/useTagBrowser/useBacklinks/useBookmarks/useWorkspace)
 * with one bus keyed on the raw WS envelope event string, so a reader can
 * trace a `createResource` registration back to `useSessionSync`'s switch by
 * string match rather than an imported function name.
 */

const subscribers = new Map<string, Set<() => void>>();

export function publish(event: string): void {
  const set = subscribers.get(event);
  if (!set || set.size === 0) return;
  // Snapshot before iterating: a listener may subscribe or unsubscribe
  // itself during fan-out and must not cause a concurrent-mutation error.
  const snapshot = Array.from(set);
  for (const listener of snapshot) listener();
}

export function subscribe(event: string, listener: () => void): () => void {
  let set = subscribers.get(event);
  if (!set) {
    set = new Set();
    subscribers.set(event, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
  };
}

export const __testing__ = {
  getSubscriberCount(event?: string): number {
    if (event !== undefined) return subscribers.get(event)?.size ?? 0;
    let total = 0;
    for (const set of subscribers.values()) total += set.size;
    return total;
  },
  reset(): void {
    subscribers.clear();
  },
};
