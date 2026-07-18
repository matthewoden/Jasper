/**
 * Tests for useDeepLink — boot-time ?note= / ?path= resolver.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const getMock = vi.fn();

vi.mock("../api/client", () => ({
  client: {
    GET: (...args: unknown[]) => getMock(...args),
  },
}));

import { useDeepLink } from "./useDeepLink";
import { usePaneStore } from "./usePaneStore";

const NOTE_ID = "00000000-0000-4000-a000-000000000001";


const originalLocation = window.location;
let assignSpy: ReturnType<typeof vi.fn>;
let replaceStateSpy: ReturnType<typeof vi.spyOn>;
let openInActivePaneSpy: ReturnType<typeof vi.spyOn>;

function makeLocationStub(search: string): Location {
  const url = new URL("http://localhost/" + (search ? `?${search}` : ""));
  return {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    ancestorOrigins: {} as DOMStringList,
    assign: assignSpy,
    reload: () => {},
    replace: () => {},
    toString: () => url.href,
  } as unknown as Location;
}

function setUrl(search: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: makeLocationStub(search),
  });
}

beforeEach(() => {
  getMock.mockReset();
  usePaneStore.getState().clearAll();
  openInActivePaneSpy = vi.spyOn(usePaneStore.getState(), "openInActivePane");

  assignSpy = vi.fn();
  setUrl("");
  replaceStateSpy = vi
    .spyOn(window.history, "replaceState")
    .mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  replaceStateSpy.mockRestore();
});

describe("useDeepLink", () => {
  it("DL-1: ?note=<uuid> resolves → openInActivePane called + URL cleaned", async () => {
    setUrl(`note=${NOTE_ID}`);
    getMock.mockResolvedValue({
      data: { id: NOTE_ID, path: "foo.md", content: "", updated_at: "" },
      error: undefined,
    });

    renderHook(() => useDeepLink(true));

    await waitFor(() => expect(openInActivePaneSpy).toHaveBeenCalledWith(NOTE_ID));
    expect(getMock).toHaveBeenCalledWith("/notes/{id}", {
      params: { path: { id: NOTE_ID } },
    });
    await waitFor(() => expect(replaceStateSpy).toHaveBeenCalled());
    const lastCallUrl = replaceStateSpy.mock.calls[0]?.[2] as string;
    expect(lastCallUrl).not.toMatch(/note=/);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("DL-2: ?path=<rel> resolves → openInActivePane called + URL cleaned", async () => {
    setUrl("path=projects%2Falpha.md");
    getMock.mockResolvedValue({
      data: {
        id: NOTE_ID,
        path: "projects/alpha.md",
        title: "Alpha",
        updated_at: "",
      },
      error: undefined,
    });

    renderHook(() => useDeepLink(true));

    await waitFor(() => expect(openInActivePaneSpy).toHaveBeenCalledWith(NOTE_ID));
    expect(getMock).toHaveBeenCalledWith("/notes/by-path", {
      params: { query: { path: "projects/alpha.md" } },
    });
    await waitFor(() => expect(replaceStateSpy).toHaveBeenCalled());
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("DL-3: no query params → no API call, no navigation", () => {
    setUrl("");
    renderHook(() => useDeepLink(true));
    expect(getMock).not.toHaveBeenCalled();
    expect(openInActivePaneSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("DL-4: ?note=<uuid> miss → window.location.assign /note-not-found", async () => {
    setUrl(`note=${NOTE_ID}`);
    getMock.mockResolvedValue({
      data: undefined,
      error: { code: "not_found", message: "no such note" },
    });

    renderHook(() => useDeepLink(true));

    await waitFor(() => expect(assignSpy).toHaveBeenCalled());
    const target = assignSpy.mock.calls[0]?.[0] as string;
    expect(target).toContain("/note-not-found");
    expect(target).toContain(encodeURIComponent(NOTE_ID));
    expect(openInActivePaneSpy).not.toHaveBeenCalled();
  });

  it("DL-5: both ?note= and ?path= → ?note wins (D-30)", async () => {
    setUrl(`note=${NOTE_ID}&path=foo.md`);
    getMock.mockResolvedValue({
      data: { id: NOTE_ID, path: "foo.md", content: "", updated_at: "" },
      error: undefined,
    });

    renderHook(() => useDeepLink(true));

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(getMock).toHaveBeenCalledWith("/notes/{id}", {
      params: { path: { id: NOTE_ID } },
    });
    expect(getMock).not.toHaveBeenCalledWith("/notes/by-path", expect.anything());
  });

  it("DL-6: treeReady=false → no API call (gate honored)", () => {
    setUrl(`note=${NOTE_ID}`);
    renderHook(() => useDeepLink(false));
    expect(getMock).not.toHaveBeenCalled();
    expect(openInActivePaneSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("DL-7: ?note= network error → navigates to /note-not-found", async () => {
    setUrl(`note=${NOTE_ID}`);
    getMock.mockRejectedValue(new Error("network down"));

    renderHook(() => useDeepLink(true));

    await waitFor(() => expect(assignSpy).toHaveBeenCalled());
    const target = assignSpy.mock.calls[0]?.[0] as string;
    expect(target).toContain("/note-not-found");
  });
});
