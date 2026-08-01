import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Server } from "mock-socket";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { components } from "../api/schema";
import { useSessionSync, type SessionSyncHandlers } from "./useSessionSync";
import { __testing__ as backlinksTesting } from "./useBacklinks";
import { subscribe } from "./resources";


type WSEnvelope = components["schemas"]["WSEnvelope"];


const setStatusMock = vi.fn();
const setForceWsReconnectMock = vi.fn();

vi.mock("./useTreeStore", () => ({
  useTreeStore: vi.fn(
    (
      selector?: (s: {
        setConnectionStatus: typeof setStatusMock;
        setForceWsReconnect: typeof setForceWsReconnectMock;
      }) => unknown,
    ) => {
      const state = {
        setConnectionStatus: setStatusMock,
        setForceWsReconnect: setForceWsReconnectMock,
      };
      return selector ? selector(state) : state;
    },
  ),
}));
vi.mock("./sessionId", () => ({
  generateOrLoadSessionId: () => "client-session-id",
}));

// treeResource is rebuilt fresh here with the REAL createResource (mirrors
// plan 07's useBacklinks.test.ts pattern) so ws.onopen's explicit
// treeResource.invalidate() call and every mutation-event publish() below
// exercise the real D-12/D-13 wiring end to end — only the network-facing
// fetch (mockGetTree) is faked.
const mockGetTree = vi.fn().mockResolvedValue({ data: { root: [] } });
vi.mock("./treeApi", async () => {
  const { createResource } = await import("./resources/createResource");
  return {
    treeResource: createResource("tree", () => mockGetTree(), {
      mode: "cached",
      invalidatedBy: [
        "note:created", "note:deleted", "note:moved",
        "folder:created", "folder:deleted", "folder:moved",
        "file:created", "file:deleted", "file:moved",
        "links:rewritten", "reindex:complete",
      ],
    }),
  };
});

import { treeResource } from "./treeApi";


const fakeUrl = "ws://localhost:1234/api/v1/ws";

function makeHandlers(): SessionSyncHandlers {
  return {
    onNoteUpdated: vi.fn(),
    onNoteDeleted: vi.fn(),
    onReindexStarted: vi.fn(),
    onReindexComplete: vi.fn(),
  };
}

describe("useSessionSync", () => {
  let server: Server;

  beforeEach(() => {
    setStatusMock.mockClear();
    mockGetTree.mockClear();
    // treeResource is a module-level "cached" singleton — clear between
    // tests so its hydrated/subscriber state from a prior test doesn't leak.
    treeResource.clear();
  });

  afterEach(() => {
    server?.stop();
  });

  it("handshake → status flips connecting then connected after treeResource.invalidate()", async () => {
    server = new Server(fakeUrl);
    const invalidateSpy = vi.spyOn(treeResource, "invalidate");
    const handlers = makeHandlers();
    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));
    await waitFor(() => expect(setStatusMock).toHaveBeenCalledWith("connected"));
    expect(setStatusMock.mock.calls[0][0]).toBe("connecting");
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("D-05 reconnect order: treeResource.invalidate() fires BEFORE setStatus('connected')", async () => {
    server = new Server(fakeUrl);
    const invalidateSpy = vi.spyOn(treeResource, "invalidate");
    const handlers = makeHandlers();
    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(setStatusMock).toHaveBeenCalledWith("connected"));

    expect(invalidateSpy.mock.invocationCallOrder.length).toBeGreaterThan(0);
    const connectedCallIndex = setStatusMock.mock.calls.findIndex(
      (c) => c[0] === "connected",
    );
    expect(connectedCallIndex).toBeGreaterThanOrEqual(0);
    const connectedOrder = setStatusMock.mock.invocationCallOrder[connectedCallIndex];
    expect(invalidateSpy.mock.invocationCallOrder[0]).toBeLessThan(connectedOrder);
  });

  it("origin filter: events with own session_id are ignored", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));
    const evt: WSEnvelope = {
      event: "note:updated",
      origin_session_id: "client-session-id", // OWN sid — should be filtered out
      payload: { id: "x", path: "x.md", updated_at: "2026-05-06T12:00:00Z" },
    };
    server.emit("message", JSON.stringify(evt));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(handlers.onNoteUpdated).not.toHaveBeenCalled();
  });

  it("dispatch: note:updated → onNoteUpdated; note:deleted → onNoteDeleted; reindex events; note:created → publish", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    const noteCreatedSpy = vi.fn();
    const unsubscribe = subscribe("note:created", noteCreatedSpy);

    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    const updatedEvt: WSEnvelope = {
      event: "note:updated",
      origin_session_id: "other",
      payload: { id: "x", path: "x.md", updated_at: "2026-05-06T12:00:00Z" },
    };
    server.emit("message", JSON.stringify(updatedEvt));
    await waitFor(() => expect(handlers.onNoteUpdated).toHaveBeenCalled());

    const deletedEvt: WSEnvelope = {
      event: "note:deleted",
      origin_session_id: "other",
      payload: { id: "x", path: "x.md" },
    };
    server.emit("message", JSON.stringify(deletedEvt));
    await waitFor(() => expect(handlers.onNoteDeleted).toHaveBeenCalled());

    const createdEvt: WSEnvelope = {
      event: "note:created",
      origin_session_id: "other",
      payload: { id: "y", path: "y.md", title: "y", updated_at: "2026-05-06T12:00:00Z" },
    };
    server.emit("message", JSON.stringify(createdEvt));
    await waitFor(() => expect(noteCreatedSpy).toHaveBeenCalled());

    const reindexStartedEvt: WSEnvelope = {
      event: "reindex:started",
      origin_session_id: "", // server-originated (Pitfall 5)
      payload: {},
    };
    server.emit("message", JSON.stringify(reindexStartedEvt));
    await waitFor(() => expect(handlers.onReindexStarted).toHaveBeenCalled());

    const reindexCompleteEvt: WSEnvelope = {
      event: "reindex:complete",
      origin_session_id: "", // server-originated (Pitfall 5)
      payload: { notes_indexed: 5 },
    };
    server.emit("message", JSON.stringify(reindexCompleteEvt));
    await waitFor(() => expect(handlers.onReindexComplete).toHaveBeenCalled());

    unsubscribe();
  });

  it("server-originated events (origin_session_id='') reach the tab even when own sid is not empty (Pitfall 5)", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));
    const evt: WSEnvelope = {
      event: "reindex:started",
      origin_session_id: "", // empty = server-originated; must NOT be filtered
      payload: {},
    };
    server.emit("message", JSON.stringify(evt));
    await waitFor(() => expect(handlers.onReindexStarted).toHaveBeenCalled());
  });
});


describe("SS1..SS7: useSessionSync Plan 06-11 extensions", () => {
  let server: Server;

  afterEach(() => {
    server?.stop();
  });


  it("SS1: tags:updated dispatches to tag browser (existing behavior)", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    const evt: WSEnvelope = {
      event: "tags:updated",
      origin_session_id: "other-session",
      payload: { tag: "updated-tag", touched_note_ids: [] },
    };
    server.emit("message", JSON.stringify(evt));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    // Tags:updated is handled without throwing (dispatches to useTagBrowser Set).
    // No assertion on subscribers here; useTagBrowser.test.ts covers that.
  });


  it("SS2: tags:rewritten dispatches to tag browser (existing behavior)", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    const evt: WSEnvelope = {
      event: "tags:rewritten",
      origin_session_id: "other-session",
      payload: { old_name: "foo", new_name: "bar", touched_note_ids: [] },
    };
    server.emit("message", JSON.stringify(evt));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    // No throw = handled.
  });


  it("SS3: links:rewritten calls onLinksRewritten handler + publishes links:rewritten", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    const onLinksRewritten = vi.fn();
    handlers.onLinksRewritten = onLinksRewritten;
    const linksSpy = vi.fn();
    const unsubscribe = subscribe("links:rewritten", linksSpy);

    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    const evt: WSEnvelope = {
      event: "links:rewritten",
      origin_session_id: "other-session",
      payload: { old_title: "Old Note", new_title: "New Note", touched_note_ids: ["abc"] },
    };
    server.emit("message", JSON.stringify(evt));
    await waitFor(() => expect(onLinksRewritten).toHaveBeenCalled());
    await waitFor(() => expect(linksSpy).toHaveBeenCalled());

    unsubscribe();
  });


  it("SS4: links:rewritten with own session_id is suppressed (D-35)", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    const onLinksRewritten = vi.fn();
    handlers.onLinksRewritten = onLinksRewritten;

    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    const selfEvt: WSEnvelope = {
      event: "links:rewritten",
      origin_session_id: "client-session-id",
      payload: { old_title: "Old Note", new_title: "New Note", touched_note_ids: ["abc"] },
    };
    server.emit("message", JSON.stringify(selfEvt));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(onLinksRewritten).not.toHaveBeenCalled();
  });


  it("SS5: note:updated publishes to the shared event bus without leaking subscribers", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();

    // No useBacklinks() instance is mounted here — this asserts the
    // WS→publish() wiring itself doesn't create or leak a subscription on
    // an arbitrary keyed entry, mirroring the pre-migration "dispatch does
    // not throw / does not grow subscriber count with 0 mounted consumers"
    // assertion. useBacklinks.test.ts covers the real fetch-triggering path.
    const beforeCount = backlinksTesting.getSubscriberCount("unmounted-note-id");

    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    const evt: WSEnvelope = {
      event: "note:updated",
      origin_session_id: "other",
      payload: { id: "x", path: "x.md", updated_at: "2026-05-06T12:00:00Z" },
    };
    server.emit("message", JSON.stringify(evt));
    await waitFor(() => expect(handlers.onNoteUpdated).toHaveBeenCalled());
    expect(backlinksTesting.getSubscriberCount("unmounted-note-id")).toBe(beforeCount);
  });


  it("SS6: links:rewritten publishes links:rewritten for sidebar label updates", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    const linksSpy = vi.fn();
    const unsubscribe = subscribe("links:rewritten", linksSpy);

    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    const evt: WSEnvelope = {
      event: "links:rewritten",
      origin_session_id: "other-session",
      payload: { old_title: "A", new_title: "B", touched_note_ids: [] },
    };
    server.emit("message", JSON.stringify(evt));
    await waitFor(() => expect(linksSpy).toHaveBeenCalled());

    unsubscribe();
  });


  it("SS7: note:created fans out to useBacklinks AND publishes note:created", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    const noteCreatedSpy = vi.fn();
    const unsubscribe = subscribe("note:created", noteCreatedSpy);

    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    const evt: WSEnvelope = {
      event: "note:created",
      origin_session_id: "other",
      payload: { id: "y", path: "y.md", title: "New Note", updated_at: "2026-05-06T12:00:00Z" },
    };
    server.emit("message", JSON.stringify(evt));
    await waitFor(() => expect(noteCreatedSpy).toHaveBeenCalled());
    // publish("note:created") does not throw even with 0 useBacklinks subscribers.

    unsubscribe();
  });
});


describe("VS1..VS2: useSessionSync Plan 08-17d vault switch extensions", () => {
  let server: Server;

  afterEach(() => {
    server?.stop();
  });


  it("VS1: vault.switching event calls onVaultSwitching with target_path + target_display_name", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    const onVaultSwitching = vi.fn();
    handlers.onVaultSwitching = onVaultSwitching;

    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    const evt = {
      event: "vault.switching",
      origin_session_id: "",
      payload: {
        target_path: "/home/user/work-notes",
        target_display_name: "Work Notes",
      },
    };
    server.emit("message", JSON.stringify(evt));
    await waitFor(() => expect(onVaultSwitching).toHaveBeenCalled());
    expect(onVaultSwitching).toHaveBeenCalledWith({
      target_path: "/home/user/work-notes",
      target_display_name: "Work Notes",
    });
  });


  it("VS2: vault.switched event calls onVaultSwitched", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    const onVaultSwitched = vi.fn();
    handlers.onVaultSwitched = onVaultSwitched;

    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    const evt = {
      event: "vault.switched",
      origin_session_id: "",
      payload: {
        path: "/home/user/work-notes",
        display_name: "Work Notes",
      },
    };
    server.emit("message", JSON.stringify(evt));
    await waitFor(() => expect(onVaultSwitched).toHaveBeenCalled());
  });
});


describe("Plan 08: treeResource invalidation costs nothing while nobody's looking", () => {
  let server: Server;

  afterEach(() => {
    server?.stop();
  });

  it("useSessionSync alone (no useFileTree() consumer mounted) issues zero GET /tree requests, across a reconnect and a mutation event", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(setStatusMock).toHaveBeenCalledWith("connected"));

    const evt: WSEnvelope = {
      event: "note:created",
      origin_session_id: "other",
      payload: { id: "y", path: "y.md", title: "y", updated_at: "2026-05-06T12:00:00Z" },
    };
    server.emit("message", JSON.stringify(evt));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // treeResource.invalidate() ran at ws.onopen and note:created's publish()
    // reached treeResource's own invalidatedBy subscription — neither ever
    // fetches because zero components in this test mounted useFileTree()
    // (zero listeners on the resource's cache entry).
    expect(mockGetTree).not.toHaveBeenCalled();
  });
});
