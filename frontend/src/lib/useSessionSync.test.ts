import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Server } from "mock-socket";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { components } from "../api/schema";
import { useSessionSync, type SessionSyncHandlers } from "./useSessionSync";

// Amendment 2: all fixtures use the generated schema types — no bypass casts.
type WSEnvelope = components["schemas"]["WSEnvelope"];

// Mock useFileTree and useTreeStore to avoid spinning up real stores.
const refreshMock = vi.fn(async () => {});
const setStatusMock = vi.fn();

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
    (selector?: (s: { setConnectionStatus: typeof setStatusMock }) => unknown) =>
      selector ? selector({ setConnectionStatus: setStatusMock }) : { setConnectionStatus: setStatusMock },
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
    // Use typed fixture per Amendment 2
    const evt: WSEnvelope = {
      event: "note:updated",
      origin_session_id: "client-session-id", // OWN sid — should be filtered out
      payload: { id: "x", path: "x.md", updated_at: "2026-05-06T12:00:00Z" },
    };
    server.emit("message", JSON.stringify(evt));
    // Wait a tick to let any dispatch happen.
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
