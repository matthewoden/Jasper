/**
 * Generic fetch-once-and-cache primitive, generalizing useFileTree.ts's
 * coalescer (leading-plus-trailing single-flight with a 100ms tail) to
 * every GET endpoint in the app.
 *
 * The one property every caller must be able to rely on (D-12, commit
 * 7494174d): a read() issued while a fetch is in flight MAY join it — a
 * component just mounted and wants whatever is current. An invalidate()
 * issued at the same moment must NEVER join it — a WS event said data
 * changed at time T, so a request issued before T cannot be trusted to
 * reflect it. invalidate() always starts a fetch strictly after the
 * in-flight one resolves. Collapsing these two entry points into one is
 * exactly the regression this primitive exists to prevent.
 */
import * as eventBus from "./eventBus";

export const COALESCE_TAIL_MS = 100;

export type ResourceMode = "cached" | "boot-scoped" | "pass-through";

export interface ResourceOptions {
  mode: ResourceMode;
  invalidatedBy?: string[];
}

export interface ResourceSnapshot<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
  hydrated: boolean;
}

export interface MutateSpec<T, R> {
  optimistic?: (current: T | undefined) => T;
  request: () => Promise<R>;
  commit?: (live: T | undefined, result: R) => T;
  rollback?: (previous: T | undefined) => T;
}

export interface Resource<T> {
  key: string;
  mode: ResourceMode;
  read(): Promise<T>;
  invalidate(): Promise<T>;
  peek(): ResourceSnapshot<T>;
  subscribe(listener: () => void): () => void;
  patch(recipe: (current: T) => T): void;
  mutate<R>(spec: MutateSpec<T, R>): Promise<R>;
  clear(): void;
}

interface CacheEntry<T> {
  data: T | undefined;
  error: Error | null;
  hydrated: boolean;
  loading: boolean;
  inFlight: Promise<T> | null;
  lastResolvedAt: number;
  pendingTrailingPromise: Promise<T> | null;
  pendingTrailingResolve: ((v: T) => void) | null;
  pendingTrailingReject: ((e: unknown) => void) | null;
  pendingTrailingTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<() => void>;
  fetchCount: number;
  snapshot: ResourceSnapshot<T> | null;
}

interface Registration {
  mode: ResourceMode;
  keyed: boolean;
  currentParam: string | null;
}

const entries = new Map<string, CacheEntry<unknown>>();
const registrations = new Map<string, Registration>();
const eventUnsubscribes = new Map<string, (() => void)[]>();

function makeEntry<T>(): CacheEntry<T> {
  return {
    data: undefined,
    error: null,
    hydrated: false,
    loading: false,
    inFlight: null,
    lastResolvedAt: 0,
    pendingTrailingPromise: null,
    pendingTrailingResolve: null,
    pendingTrailingReject: null,
    pendingTrailingTimer: null,
    listeners: new Set(),
    fetchCount: 0,
    snapshot: null,
  };
}

function getOrCreateEntry<T>(fullKey: string): CacheEntry<T> {
  let entry = entries.get(fullKey) as CacheEntry<T> | undefined;
  if (!entry) {
    entry = makeEntry<T>();
    entries.set(fullKey, entry as CacheEntry<unknown>);
  }
  return entry;
}

function notify<T>(entry: CacheEntry<T>): void {
  // Rebuilt lazily by peek() — only invalidated here, where a field
  // actually changed, so useSyncExternalStore doesn't see a new object
  // (and re-render) on every check.
  entry.snapshot = null;
  const snapshot = Array.from(entry.listeners);
  for (const fn of snapshot) fn();
}

function startInFlight<T>(
  entry: CacheEntry<T>,
  fetcher: () => Promise<T>,
  mode: ResourceMode,
): Promise<T> {
  entry.fetchCount++;
  entry.loading = true;
  notify(entry);
  const promise = fetcher()
    .then(
      (result) => {
        if (mode !== "pass-through") {
          entry.data = result;
          entry.hydrated = true;
        }
        entry.error = null;
        return result;
      },
      (err: unknown) => {
        entry.error = err instanceof Error ? err : new Error(String(err));
        throw err;
      },
    )
    .finally(() => {
      entry.inFlight = null;
      entry.lastResolvedAt = Date.now();
      entry.loading = false;
      notify(entry);
    });
  entry.inFlight = promise;
  return promise;
}

function queueTrailing<T>(
  entry: CacheEntry<T>,
  fetcher: () => Promise<T>,
  mode: ResourceMode,
  delayMs: number,
): Promise<T> {
  if (entry.pendingTrailingPromise === null) {
    entry.pendingTrailingPromise = new Promise<T>((resolve, reject) => {
      entry.pendingTrailingResolve = resolve;
      entry.pendingTrailingReject = reject;
    });
  }
  if (entry.pendingTrailingTimer !== null) clearTimeout(entry.pendingTrailingTimer);
  entry.pendingTrailingTimer = setTimeout(
    () => flushTrailing(entry, fetcher, mode),
    delayMs,
  );
  return entry.pendingTrailingPromise;
}

function flushTrailing<T>(
  entry: CacheEntry<T>,
  fetcher: () => Promise<T>,
  mode: ResourceMode,
): void {
  if (entry.pendingTrailingTimer !== null) {
    clearTimeout(entry.pendingTrailingTimer);
    entry.pendingTrailingTimer = null;
  }
  // Something started fetching after we were queued but hasn't resolved
  // yet (the fetch we deferred behind, or a trailing fetch from an
  // earlier flush). Its request predates us too — wait for it to finish,
  // then re-evaluate, rather than joining it.
  if (entry.inFlight !== null) {
    void entry.inFlight.finally(() => flushTrailing(entry, fetcher, mode));
    return;
  }
  const resolve = entry.pendingTrailingResolve;
  const reject = entry.pendingTrailingReject;
  entry.pendingTrailingResolve = null;
  entry.pendingTrailingReject = null;
  entry.pendingTrailingPromise = null;
  if (resolve === null || reject === null) return;
  startInFlight(entry, fetcher, mode).then(resolve, reject);
}

function readEntry<T>(
  entry: CacheEntry<T>,
  fetcher: () => Promise<T>,
  mode: ResourceMode,
): Promise<T> {
  if (entry.inFlight !== null) return entry.inFlight;
  if (entry.hydrated && (mode === "cached" || mode === "boot-scoped")) {
    return Promise.resolve(entry.data as T);
  }
  return startInFlight(entry, fetcher, mode);
}

function invalidateEntry<T>(
  entry: CacheEntry<T>,
  fetcher: () => Promise<T>,
  mode: ResourceMode,
): Promise<T> {
  // A resource nobody is looking at costs nothing: mark it stale instead
  // of fetching. The next 0->1 subscribe transition sees a non-hydrated
  // entry and fetches fresh via read().
  if (entry.listeners.size === 0) {
    entry.hydrated = false;
    if (mode === "cached" || mode === "boot-scoped") {
      entry.data = undefined;
    }
    notify(entry);
    return Promise.resolve(entry.data as T);
  }
  if (entry.inFlight !== null) {
    return queueTrailing(entry, fetcher, mode, 0);
  }
  const elapsed = Date.now() - entry.lastResolvedAt;
  if (entry.lastResolvedAt > 0 && elapsed < COALESCE_TAIL_MS) {
    return queueTrailing(entry, fetcher, mode, COALESCE_TAIL_MS - elapsed);
  }
  return startInFlight(entry, fetcher, mode);
}

function peekEntry<T>(entry: CacheEntry<T>): ResourceSnapshot<T> {
  if (entry.snapshot === null) {
    entry.snapshot = {
      data: entry.data,
      loading: entry.loading,
      error: entry.error,
      hydrated: entry.hydrated,
    };
  }
  return entry.snapshot;
}

function evictSiblingIfKeyed(fullKey: string, baseKey: string): void {
  const reg = registrations.get(baseKey);
  if (!reg || !reg.keyed) return;
  const param = fullKey === baseKey ? null : fullKey.slice(baseKey.length + 2);
  if (reg.currentParam !== null && reg.currentParam !== param) {
    entries.delete(`${baseKey}::${reg.currentParam}`);
  }
  reg.currentParam = param;
}

function subscribeEntry<T>(
  fullKey: string,
  baseKey: string,
  entry: CacheEntry<T>,
  fetcher: () => Promise<T>,
  mode: ResourceMode,
  listener: () => void,
): () => void {
  const wasEmpty = entry.listeners.size === 0;
  entry.listeners.add(listener);
  if (wasEmpty) {
    evictSiblingIfKeyed(fullKey, baseKey);
    // D-14: the first subscriber triggers the fetch; every later
    // subscriber reads cache. read() resolves from cache with no network
    // call when the entry is already hydrated, so a later remount costs
    // zero requests (D-15).
    void readEntry(entry, fetcher, mode).catch(() => undefined);
  }
  return () => {
    entry.listeners.delete(listener);
  };
}

function patchEntry<T>(entry: CacheEntry<T>, recipe: (current: T) => T): void {
  if (entry.data === undefined) return;
  entry.data = recipe(entry.data);
  notify(entry);
}

async function mutateEntry<T, R>(
  entry: CacheEntry<T>,
  spec: MutateSpec<T, R>,
): Promise<R> {
  const previous = entry.data;
  if (spec.optimistic) {
    entry.data = spec.optimistic(previous);
    notify(entry);
  }
  try {
    const result = await spec.request();
    // Reconcile against the LIVE cache entry at success time, not the
    // closed-over pre-request snapshot — a concurrent WS-driven update
    // could have landed while `request()` was in flight.
    const live = entry.data;
    if (spec.commit) {
      entry.data = spec.commit(live, result);
    }
    notify(entry);
    return result;
  } catch (err) {
    entry.data = spec.rollback ? spec.rollback(previous) : previous;
    notify(entry);
    throw err;
  }
}

function clearEntry<T>(entry: CacheEntry<T>): void {
  if (entry.pendingTrailingTimer !== null) {
    clearTimeout(entry.pendingTrailingTimer);
    entry.pendingTrailingTimer = null;
  }
  entry.data = undefined;
  entry.error = null;
  entry.hydrated = false;
  entry.loading = false;
  entry.lastResolvedAt = 0;
  entry.pendingTrailingPromise = null;
  entry.pendingTrailingResolve = null;
  entry.pendingTrailingReject = null;
  notify(entry);
}

function validateOptions(key: string, options: ResourceOptions): void {
  const invalidatedBy = options.invalidatedBy ?? [];
  if (options.mode === "cached") {
    if (invalidatedBy.length === 0) {
      throw new Error(
        `createResource("${key}"): mode "cached" requires a non-empty invalidatedBy list`,
      );
    }
    return;
  }
  if (invalidatedBy.length > 0) {
    throw new Error(
      `createResource("${key}"): mode "${options.mode}" must not declare invalidatedBy`,
    );
  }
}

function makeResourceView<T>(
  fullKey: string,
  baseKey: string,
  fetcher: () => Promise<T>,
  mode: ResourceMode,
): Resource<T> {
  return {
    key: baseKey,
    mode,
    read: () => readEntry(getOrCreateEntry<T>(fullKey), fetcher, mode),
    invalidate: () => invalidateEntry(getOrCreateEntry<T>(fullKey), fetcher, mode),
    peek: () => peekEntry(getOrCreateEntry<T>(fullKey)),
    subscribe: (listener) =>
      subscribeEntry(
        fullKey,
        baseKey,
        getOrCreateEntry<T>(fullKey),
        fetcher,
        mode,
        listener,
      ),
    patch: (recipe) => patchEntry(getOrCreateEntry<T>(fullKey), recipe),
    mutate: (spec) => mutateEntry(getOrCreateEntry<T>(fullKey), spec),
    clear: () => clearEntry(getOrCreateEntry<T>(fullKey)),
  };
}

export function createResource<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: ResourceOptions,
): Resource<T> {
  validateOptions(key, options);
  registrations.set(key, { mode: options.mode, keyed: false, currentParam: null });
  const resource = makeResourceView<T>(key, key, fetcher, options.mode);
  eventUnsubscribes.set(
    key,
    (options.invalidatedBy ?? []).map((event) =>
      eventBus.subscribe(event, () => {
        void resource.invalidate().catch(() => undefined);
      }),
    ),
  );
  return resource;
}

export function createKeyedResource<T>(
  key: string,
  fetcher: (param: string) => Promise<T>,
  options: ResourceOptions,
): { forKey(param: string): Resource<T>; clear(): void } {
  validateOptions(key, options);
  const reg: Registration = { mode: options.mode, keyed: true, currentParam: null };
  registrations.set(key, reg);
  eventUnsubscribes.set(
    key,
    (options.invalidatedBy ?? []).map((event) =>
      eventBus.subscribe(event, () => {
        if (reg.currentParam === null) return;
        const fullKey = `${key}::${reg.currentParam}`;
        const currentFetcher = () => fetcher(reg.currentParam as string);
        void invalidateEntry(
          getOrCreateEntry<T>(fullKey),
          currentFetcher,
          options.mode,
        ).catch(() => undefined);
      }),
    ),
  );
  return {
    forKey(param: string): Resource<T> {
      const fullKey = `${key}::${param}`;
      return makeResourceView<T>(fullKey, key, () => fetcher(param), options.mode);
    },
    clear(): void {
      for (const [fullKey, entry] of entries) {
        if (fullKey.startsWith(`${key}::`)) clearEntry(entry);
      }
    },
  };
}

export function clearAllResources(): void {
  for (const entry of entries.values()) clearEntry(entry);
}

export const __testing__ = {
  getSubscriberCount(key: string): number {
    return entries.get(key)?.listeners.size ?? 0;
  },
  getCacheEntry(key: string): ResourceSnapshot<unknown> | undefined {
    const entry = entries.get(key);
    return entry ? peekEntry(entry) : undefined;
  },
  getFetchCount(key: string): number {
    return entries.get(key)?.fetchCount ?? 0;
  },
  reset(): void {
    for (const unsubs of eventUnsubscribes.values()) {
      for (const unsub of unsubs) unsub();
    }
    entries.clear();
    registrations.clear();
    eventUnsubscribes.clear();
  },
};
