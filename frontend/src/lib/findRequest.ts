/**
 * Find/Replace lives in LeafPane's local state, so an entry point outside a
 * pane — a sidebar row menu — has no handle on it. This is that handle: a
 * module-level emitter the active leaf listens on, in the same imperative
 * spirit as revealInNavigation.
 */
export type FindRequestMode = "find" | "replace";

const listeners = new Set<(mode: FindRequestMode) => void>();

export function requestFind(mode: FindRequestMode): void {
  for (const listener of listeners) listener(mode);
}

export function onFindRequest(
  listener: (mode: FindRequestMode) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
