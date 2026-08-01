import { StrictMode, type ReactElement } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __testing__ as eventBusTesting, publish } from "./eventBus";
import { __testing__, createResource, type Resource } from "./createResource";
import { useResource } from "./useResource";

beforeEach(() => {
  __testing__.reset();
  eventBusTesting.reset();
});

function Reader<T>({ resource }: { resource: Resource<T> | null }): ReactElement {
  const snapshot = useResource(resource);
  return (
    <div data-testid="reader">
      {snapshot.loading ? "loading" : JSON.stringify(snapshot.data)}
    </div>
  );
}

describe("useResource", () => {
  it("first subscriber triggers fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue("value");
    const resource = createResource("test-first-subscriber", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    render(<Reader resource={resource} />);

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  });

  it("subscribe does not fetch: a second and third mount against an already-hydrated resource costs zero requests", async () => {
    const fetcher = vi.fn().mockResolvedValue("value");
    const resource = createResource("test-no-refetch-on-mount", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    const first = render(<Reader resource={resource} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    render(<Reader resource={resource} />);
    render(<Reader resource={resource} />);

    // Give any accidental extra fetch a chance to fire before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);

    first.unmount();
  });

  it("strictmode double invoke nets one fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue("value");
    const resource = createResource("test-strictmode", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    render(
      <StrictMode>
        <Reader resource={resource} />
      </StrictMode>,
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  });

  it("one event one refetch: three mounted components produce exactly one extra fetch per published event", async () => {
    const fetcher = vi.fn().mockResolvedValue("value");
    const resource = createResource("test-one-event-one-refetch", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    render(<Reader resource={resource} />);
    render(<Reader resource={resource} />);
    render(<Reader resource={resource} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    publish("x:changed");

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    // Give any over-fanned-out extra fetch a chance to fire.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("no subscriber leak: unmounting every component leaves the subscriber count at zero", async () => {
    const fetcher = vi.fn().mockResolvedValue("value");
    const resource = createResource("test-no-leak", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    const a = render(<Reader resource={resource} />);
    const b = render(<Reader resource={resource} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    expect(__testing__.getSubscriberCount("test-no-leak")).toBe(2);

    a.unmount();
    b.unmount();

    expect(__testing__.getSubscriberCount("test-no-leak")).toBe(0);
  });

  it("mutate rollback: an optimistic patch is visible immediately, and a rejected request restores the pre-mutation value", async () => {
    const fetcher = vi.fn(() => Promise.resolve<string[]>(["a"]));
    const resource = createResource<string[]>("test-mutate-rollback", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    render(<Reader resource={resource} />);
    await waitFor(() =>
      expect(document.querySelector('[data-testid="reader"]')?.textContent).toBe(
        JSON.stringify(["a"]),
      ),
    );

    let rejectRequest!: (err: Error) => void;
    const request = vi.fn(
      () =>
        new Promise<string[]>((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );

    let mutatePromise!: Promise<string[]>;
    act(() => {
      mutatePromise = resource.mutate({
        optimistic: (current) => [...(current ?? []), "pending"],
        request,
        rollback: (previous) => previous ?? [],
      });
    });
    // Attach a catch handler synchronously so the eventual rejection is
    // never briefly "unhandled" between here and the later await.
    const settled = mutatePromise.catch((err: unknown) => err);

    await waitFor(() =>
      expect(document.querySelector('[data-testid="reader"]')?.textContent).toBe(
        JSON.stringify(["a", "pending"]),
      ),
    );

    await act(async () => {
      rejectRequest(new Error("network"));
      await settled;
    });

    await waitFor(() =>
      expect(document.querySelector('[data-testid="reader"]')?.textContent).toBe(
        JSON.stringify(["a"]),
      ),
    );

    const result = await settled;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("network");
  });

  it("snapshot is referentially stable: two consecutive peek() calls with no intervening change return the same object reference", async () => {
    const fetcher = vi.fn().mockResolvedValue("value");
    const resource = createResource("test-stable-snapshot", fetcher, {
      mode: "cached",
      invalidatedBy: ["x:changed"],
    });

    render(<Reader resource={resource} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    const snapshot1 = resource.peek();
    const snapshot2 = resource.peek();
    expect(snapshot1).toBe(snapshot2);
  });

  it("returns the frozen empty snapshot with no allocation when resource is null", () => {
    const snapshot1Holder: { current: unknown } = { current: undefined };
    function Probe(): ReactElement {
      const snapshot = useResource(null);
      snapshot1Holder.current = snapshot;
      return <div>{String(snapshot.hydrated)}</div>;
    }

    const { rerender } = render(<Probe />);
    const first = snapshot1Holder.current;
    rerender(<Probe />);
    const second = snapshot1Holder.current;

    expect(first).toBe(second);
  });
});
