/**
 * useSyncExternalStore binding over a Resource's cache. Reading is a
 * render-time snapshot rather than an effect, so subscribing structurally
 * cannot trigger a fetch (D-11) — immune to tearing and to StrictMode's
 * double-invocation. The fetch-on-first-subscriber trigger (D-14) lives in
 * createResource.ts's own subscribe(), not here.
 */
import { useCallback, useSyncExternalStore } from "react";

import type { Resource, ResourceSnapshot } from "./createResource";

const EMPTY_SNAPSHOT: ResourceSnapshot<unknown> = Object.freeze({
  data: undefined,
  loading: false,
  error: null,
  hydrated: false,
});

export function useResource<T>(
  resource: Resource<T> | null,
): ResourceSnapshot<T> {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!resource) return () => undefined;
      return resource.subscribe(onStoreChange);
    },
    [resource],
  );
  const getSnapshot = useCallback(
    (): ResourceSnapshot<T> =>
      resource ? resource.peek() : (EMPTY_SNAPSHOT as ResourceSnapshot<T>),
    [resource],
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}
