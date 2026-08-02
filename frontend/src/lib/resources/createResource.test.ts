import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __testing__ as eventBusTesting,
  publish,
} from "./eventBus";
import {
  __testing__,
  clearAllResources,
  createKeyedResource,
  createResource,
} from "./createResource";

beforeEach(() => {
  __testing__.reset();
  eventBusTesting.reset();
});

describe("createResource — coalescer", () => {
  it("concurrent callers coalesce", async () => {
    let resolveFetch!: (v: number) => void;
    const pending = new Promise<number>((resolve) => {
      resolveFetch = resolve;
    });
    const fetcher = vi.fn().mockImplementationOnce(() => pending);
    const resource = createResource("test-concurrent", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    const p1 = resource.read();
    const p2 = resource.read();
    const p3 = resource.read();
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch(42);
    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual([42, 42, 42]);
  });

  it("params-keyed dedupe", async () => {
    const fetcher = vi.fn((param: string) => Promise.resolve(`data-${param}`));
    const keyed = createKeyedResource("test-keyed", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    const [a1, a2, b] = await Promise.all([
      keyed.forKey("a").read(),
      keyed.forKey("a").read(),
      keyed.forKey("b").read(),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith("a");
    expect(fetcher).toHaveBeenCalledWith("b");
    expect(a1).toBe("data-a");
    expect(a2).toBe("data-a");
    expect(b).toBe("data-b");
  });

  it("REGRESSION never-join-a-stale-invalidation: an invalidation arriving while a read is in flight must not resolve from that stale fetch", async () => {
    let resolveStale!: (v: string) => void;
    const stale = new Promise<string>((resolve) => {
      resolveStale = resolve;
    });
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => stale)
      .mockResolvedValueOnce("fresh");

    const resource = createResource("test-regression", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });
    // A subscriber must be present, or invalidate() takes the
    // zero-subscriber "mark stale, don't fetch" path instead.
    resource.subscribe(() => undefined);

    // call #1: mount-shaped read, still pending.
    const readCall = resource.read();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // call #2: a WS-event-shaped invalidation arriving WHILE call #1 is
    // still in flight — this is the exact race from
    // opennotefromtree-row-missing (commit 7494174d), ported onto the
    // generic primitive.
    const invalidateCall = resource.invalidate();

    // call #1's request was issued before whatever changed, so it
    // resolves without the new data.
    resolveStale("stale");

    const [readResult, invalidateResult] = await Promise.all([
      readCall,
      invalidateCall,
    ]);

    expect(readResult).toBe("stale");
    // The invalidation must NOT be satisfied by call #1's stale,
    // pre-change snapshot — it must reflect a fetch issued after its own
    // call.
    expect(invalidateResult).toBe("fresh");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("read may join: a second read() call while the first is in flight joins it", async () => {
    let resolveFetch!: (v: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveFetch = resolve;
    });
    const fetcher = vi.fn().mockImplementationOnce(() => pending);
    const resource = createResource("test-read-join", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    const call1 = resource.read();
    const call2 = resource.read();
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch("value");
    const [r1, r2] = await Promise.all([call1, call2]);
    expect(r1).toBe("value");
    expect(r2).toBe("value");
  });

  it("clears the in-flight slot on rejection so subsequent calls retry", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce("ok");
    const resource = createResource("test-reject", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    await expect(resource.read()).rejects.toThrow("network");
    const second = await resource.read();
    expect(second).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves last good value on failure", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockRejectedValueOnce(new Error("boom"));
    const resource = createResource("test-preserve", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });
    resource.subscribe(() => undefined);

    await resource.read();
    expect(resource.peek().data).toBe("first");

    await expect(resource.invalidate()).rejects.toThrow("boom");

    const snapshot = resource.peek();
    expect(snapshot.data).toBe("first");
    expect(snapshot.error?.message).toBe("boom");
    expect(snapshot.hydrated).toBe(true);
  });

  it("cached read after hydrate issues no fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue("value");
    const resource = createResource("test-cached-no-refetch", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    await resource.read();
    await resource.read();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("pass-through never caches", async () => {
    const fetcher = vi.fn().mockResolvedValue("value");
    const resource = createResource("test-pass-through", fetcher, {
      mode: "pass-through",
    });

    await resource.read();
    await resource.read();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(resource.peek().data).toBeUndefined();
  });

  it("single-slot keyed eviction", async () => {
    const fetcher = vi.fn((param: string) => Promise.resolve(`data-${param}`));
    const keyed = createKeyedResource("test-single-slot", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    const resourceA = keyed.forKey("a");
    resourceA.subscribe(() => undefined);
    await resourceA.read();
    expect(__testing__.getCacheEntry("test-single-slot::a")?.data).toBe(
      "data-a",
    );

    const resourceB = keyed.forKey("b");
    resourceB.subscribe(() => undefined);

    expect(__testing__.getCacheEntry("test-single-slot::a")).toBeUndefined();
  });

  it("forKey is pure: calling forKey without subscribing does not evict or fetch", async () => {
    const fetcher = vi.fn((param: string) => Promise.resolve(`data-${param}`));
    const keyed = createKeyedResource("test-forkey-pure", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    const resourceA = keyed.forKey("a");
    resourceA.subscribe(() => undefined);
    await resourceA.read();
    expect(fetcher).toHaveBeenCalledTimes(1);

    keyed.forKey("b");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(__testing__.getCacheEntry("test-forkey-pure::a")?.data).toBe(
      "data-a",
    );
  });

  it("mode/invalidatedBy validation", () => {
    expect(() =>
      createResource("test-validate-cached", vi.fn(), { mode: "cached" }),
    ).toThrow();
    expect(() =>
      createResource("test-validate-boot", vi.fn(), {
        mode: "boot-scoped",
        invalidatedBy: ["x:changed"],
      }),
    ).toThrow();
  });

  it("invalidate with zero subscribers does not fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue("value");
    const resource = createResource("test-zero-subscribers", fetcher, {
      mode: "cached",
      invalidatedBy: ["zero-sub:changed"],
    });

    const unsubscribe = resource.subscribe(() => undefined);
    await resource.read();
    expect(fetcher).toHaveBeenCalledTimes(1);
    unsubscribe();

    publish("zero-sub:changed");
    await Promise.resolve();
    await Promise.resolve();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(resource.peek().hydrated).toBe(false);

    await resource.read();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("REGRESSION pass-through invalidate with zero subscribers still fetches: a pass-through resource has no persistent subscriber by construction, so the zero-subscriber stale-mark shortcut must not apply to it", async () => {
    const fetcher = vi.fn((id: string) => Promise.resolve(`fresh-${id}`));
    const keyed = createKeyedResource("test-pass-through-invalidate", fetcher, {
      mode: "pass-through",
    });

    const result = await keyed.forKey("abc").invalidate();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("abc");
    expect(result).toBe("fresh-abc");
  });

  it("clearAllResources drops every entry's data", async () => {
    const fetcher = vi.fn().mockResolvedValue("value");
    const resource = createResource("test-clear-all", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    await resource.read();
    expect(resource.peek().data).toBe("value");

    clearAllResources();

    expect(resource.peek().data).toBeUndefined();
    expect(resource.peek().hydrated).toBe(false);
  });
});
