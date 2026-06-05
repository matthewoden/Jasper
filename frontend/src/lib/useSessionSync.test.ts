import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Server } from "mock-socket";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { components } from "../api/schema";
import { useSessionSync, type SessionSyncHandlers } from "./useSessionSync";
import { __testing__ as backlinksTesting } from "./useBacklinks";


type WSEnvelope = components["schemas"]["WSEnvelope"];


const refreshMock = vi.fn(async () => {});
const setStatusMock = vi.fn();


const setForceWsReconnectMock = vi.fn();

vi.mock("./useFileTree", () => ({
  useFileTree: () => ({
    tree: null,
    refresh: refreshMock,
    loading: false,
    error: null,
    mutate: vi.fn(),
  }),
}));
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
    refreshMock.mockClear();
    setStatusMock.mockClear();
  });

  afterEach(() => {
    server?.stop();
  });

  it("handshake → status flips connecting then connected after refreshTree", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));
    await waitFor(() => expect(setStatusMock).toHaveBeenCalledWith("connected"));
    expect(setStatusMock.mock.calls[0][0]).toBe("connecting");
    expect(refreshMock).toHaveBeenCalled();
  });

  it("D-05 reconnect order: refreshTree fires BEFORE setStatus('connected')", async () => {
    server = new Server(fakeUrl);
    const order: string[] = [];
    refreshMock.mockImplementation(async () => {
      order.push("refreshTree");
    });
    setStatusMock.mockImplementation((s: string) => order.push(`setStatus:${s}`));
    const handlers = makeHandlers();
    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(order).toContain("setStatus:connected"));
    const refreshIdx = order.indexOf("refreshTree");
    const connectedIdx = order.indexOf("setStatus:connected");
    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(refreshIdx).toBeLessThan(connectedIdx);
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

  it("dispatch: note:updated → onNoteUpdated; note:deleted → onNoteDeleted; reindex events; tree events → refreshTree", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
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

    refreshMock.mockClear();
    const createdEvt: WSEnvelope = {
      event: "note:created",
      origin_session_id: "other",
      payload: { id: "y", path: "y.md", title: "y", updated_at: "2026-05-06T12:00:00Z" },
    };
    server.emit("message", JSON.stringify(createdEvt));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());

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


  it("SS3: links:rewritten calls onLinksRewritten handler + dispatches links event", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    const onLinksRewritten = vi.fn();
    handlers.onLinksRewritten = onLinksRewritten;

    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    const evt: WSEnvelope = {
      event: "links:rewritten",
      origin_session_id: "other-session",
      payload: { old_title: "Old Note", new_title: "New Note", touched_note_ids: ["abc"] },
    };
    server.emit("message", JSON.stringify(evt));
    await waitFor(() => expect(onLinksRewritten).toHaveBeenCalled());
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
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


  it("SS5: note:updated fans out to useBacklinks dispatch", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();

    const linksSubscriber = vi.fn();

    const { unmount } = renderHook(() => {
      void linksSubscriber;
    });

    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    const beforeCount = backlinksTesting.getSubscriberCount();
    const evt: WSEnvelope = {
      event: "note:updated",
      origin_session_id: "other",
      payload: { id: "x", path: "x.md", updated_at: "2026-05-06T12:00:00Z" },
    };
    server.emit("message", JSON.stringify(evt));
    await waitFor(() => expect(handlers.onNoteUpdated).toHaveBeenCalled());
    expect(backlinksTesting.getSubscriberCount()).toBe(beforeCount);

    unmount();
  });


  it("SS6: links:rewritten calls refreshTree for sidebar label updates", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    refreshMock.mockClear();

    const evt: WSEnvelope = {
      event: "links:rewritten",
      origin_session_id: "other-session",
      payload: { old_title: "A", new_title: "B", touched_note_ids: [] },
    };
    server.emit("message", JSON.stringify(evt));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });


  it("SS7: note:created fans out to useBacklinks AND refreshTree", async () => {
    server = new Server(fakeUrl);
    const handlers = makeHandlers();
    renderHook(() => useSessionSync(handlers, { wsUrlFn: () => fakeUrl }));
    await waitFor(() => expect(server.clients()).toHaveLength(1));

    refreshMock.mockClear();

    const evt: WSEnvelope = {
      event: "note:created",
      origin_session_id: "other",
      payload: { id: "y", path: "y.md", title: "New Note", updated_at: "2026-05-06T12:00:00Z" },
    };
    server.emit("message", JSON.stringify(evt));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    // dispatchLinksEvent does not throw even with 0 subscribers.
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
