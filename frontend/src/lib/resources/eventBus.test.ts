import { beforeEach, describe, expect, it, vi } from "vitest";

import { __testing__, publish, subscribe } from "./eventBus";

describe("eventBus", () => {
  beforeEach(() => {
    __testing__.reset();
  });

  it("publish with zero subscribers is a no-op", () => {
    expect(() => publish("note:updated")).not.toThrow();
  });

  it("two subscribers to the same event both fire", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribe("note:updated", a);
    subscribe("note:updated", b);

    publish("note:updated");

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a subscriber to a different event does not fire", () => {
    const noteListener = vi.fn();
    const tagListener = vi.fn();
    subscribe("note:updated", noteListener);
    subscribe("tags:updated", tagListener);

    publish("note:updated");

    expect(noteListener).toHaveBeenCalledTimes(1);
    expect(tagListener).not.toHaveBeenCalled();
  });

  it("the returned unsubscribe removes exactly one listener", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribe("note:updated", a);
    const unsubscribeB = subscribe("note:updated", b);

    unsubscribeB();
    publish("note:updated");

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(__testing__.getSubscriberCount("note:updated")).toBe(1);
  });

  it("a listener that unsubscribes itself during fan-out does not throw and the remaining listeners still fire", () => {
    const remaining = vi.fn();
    let unsubscribeSelf: () => void = () => undefined;
    const selfRemoving = vi.fn(() => {
      unsubscribeSelf();
    });
    unsubscribeSelf = subscribe("note:updated", selfRemoving);
    subscribe("note:updated", remaining);

    expect(() => publish("note:updated")).not.toThrow();

    expect(selfRemoving).toHaveBeenCalledTimes(1);
    expect(remaining).toHaveBeenCalledTimes(1);
    expect(__testing__.getSubscriberCount("note:updated")).toBe(1);

    // A second publish confirms the self-removal actually took effect.
    publish("note:updated");
    expect(selfRemoving).toHaveBeenCalledTimes(1);
    expect(remaining).toHaveBeenCalledTimes(2);
  });

  it("getSubscriberCount with no argument totals across all events", () => {
    subscribe("note:updated", vi.fn());
    subscribe("tags:updated", vi.fn());
    subscribe("tags:updated", vi.fn());

    expect(__testing__.getSubscriberCount()).toBe(3);
  });

  it("reset clears the whole map", () => {
    subscribe("note:updated", vi.fn());
    __testing__.reset();
    expect(__testing__.getSubscriberCount()).toBe(0);
  });
});
