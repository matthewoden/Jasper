import { useEffect, useRef } from "react";
import { generateOrLoadSessionId } from "./sessionId";
import { nextDelay } from "./backoff";
import { useTreeStore } from "./useTreeStore";
import { useFileTree } from "./useFileTree";
import { dispatchTagEvent } from "./useTagBrowser";
import type { components } from "../api/schema";

type WSEnvelope = components["schemas"]["WSEnvelope"];
type WSNoteUpdatedPayload = components["schemas"]["WSNoteUpdatedPayload"];
type WSNoteDeletedPayload = components["schemas"]["WSNoteDeletedPayload"];
type WSReindexCompletePayload = components["schemas"]["WSReindexCompletePayload"];

export interface SessionSyncHandlers {
  onNoteUpdated: (p: WSNoteUpdatedPayload) => void;
  onNoteDeleted: (p: WSNoteDeletedPayload) => void;
  onReindexStarted: () => void;
  onReindexComplete: (p: WSReindexCompletePayload) => void;
}

/**
 * Builds the ws:// or wss:// URL for the WS upgrade. Dependency-
 * injectable for tests via the `wsUrlFn` parameter on useSessionSync.
 */
function defaultWsUrl(sid: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/v1/ws?session_id=${encodeURIComponent(sid)}`;
}

export interface UseSessionSyncOptions {
  /** Test seam: override the URL builder so mock-socket can intercept. */
  wsUrlFn?: (sid: string) => string;
}

/**
 * SYNC-01..04, SYNC-07: WebSocket session-sync hook. Mount once at App
 * root (Plan 04-05). Owns the WS connection, the connection-status
 * state machine, the reconnect loop, and the inbound-event dispatch.
 *
 * Reconnect order (D-05 a→e):
 *   (a) setStatus("reconnecting") (or "connecting" on first attempt)
 *   (b) await refreshTree on open
 *   (c) editor refetches its open note in response to status flip
 *       (handled by EditorPane in Plan 04-05; not here)
 *   (d) resume processing inbound events (just by virtue of being
 *       connected)
 *   (e) setStatus("connected")
 *
 * SECURITY (T-04-03): inbound `origin_session_id` is treated as
 * opaque — never rendered to the DOM. Used only for equality compare
 * against own session_id (origin filter, SYNC-03).
 *
 * Pitfall 9 (RESEARCH.md): all listeners attached SYNCHRONOUSLY before
 * any await between `new WebSocket(...)` and listener setup, so no
 * inbound message is lost on slow CPU.
 *
 * Pitfall 5: empty origin_session_id ("") is the protocol signal for
 * "server-originated event" (reindex:*, migration:status). These
 * events bypass the origin filter and reach every tab.
 */
export function useSessionSync(
  handlers: SessionSyncHandlers,
  opts: UseSessionSyncOptions = {},
): void {
  const setStatus = useTreeStore((s) => s.setConnectionStatus);
  const { refresh: refreshTree } = useFileTree();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const wsUrlFn = opts.wsUrlFn ?? defaultWsUrl;

  useEffect(() => {
    const sessionId = generateOrLoadSessionId();
    let cancelled = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (cancelled) return;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      ws = new WebSocket(wsUrlFn(sessionId));

      // Pitfall 9: attach all listeners SYNCHRONOUSLY before any await.
      ws.onopen = async () => {
        if (cancelled) return;
        // WR-11: reset attempt BEFORE awaiting refreshTree so that a
        // refreshTree throw does not leave the counter at >0. Previously
        // attempt was reset only AFTER the await — if refreshTree threw,
        // the `attempt = 0` line was never reached, the next ws.onclose
        // saw attempt=N, and setStatus("reconnecting") fired even though
        // the connection had been live. The status flicker
        // (connecting → reconnecting → connected after a successful
        // refresh) is suppressed by doing the reset up-front.
        attempt = 0;
        // D-05 step (b)
        try {
          await refreshTree();
        } catch {
          // refreshTree errors are surfaced inside useFileTree's own
          // store; we still flip to connected so events resume.
        }
        if (cancelled) return;
        // D-05 step (e)
        setStatus("connected");
      };

      ws.onmessage = (e) => {
        let env: WSEnvelope;
        try {
          env = JSON.parse(e.data as string) as WSEnvelope;
        } catch {
          return; // malformed; ignore
        }
        // SYNC-03 origin filter (Pitfall 5: empty string = server-originated, NOT filtered)
        if (env.origin_session_id !== "" && env.origin_session_id === sessionId) {
          return;
        }
        switch (env.event) {
          case "session:assigned":
            // Server confirms the sid. Nothing to do — we're already
            // using `sessionId` as the source of truth (Pitfall 1).
            break;
          case "note:updated":
            handlersRef.current.onNoteUpdated(
              env.payload as WSNoteUpdatedPayload,
            );
            break;
          case "note:deleted":
            handlersRef.current.onNoteDeleted(
              env.payload as WSNoteDeletedPayload,
            );
            break;
          case "note:created":
          case "note:moved":
          case "folder:created":
          case "folder:deleted":
          case "folder:moved":
            // D-07: reuse the existing tree fan-out via useFileTree.refresh.
            void refreshTree();
            break;
          case "reindex:started":
            handlersRef.current.onReindexStarted();
            break;
          case "reindex:complete":
            handlersRef.current.onReindexComplete(
              env.payload as WSReindexCompletePayload,
            );
            break;
          case "tags:updated":
          case "tags:rewritten":
            // Phase 6 — Plan 06-08: fan-out to useTagBrowser subscribers so the
            // sidebar tag list refreshes when another session modifies tags.
            // dispatchTagEvent uses the module-level Set pattern (mirrors
            // treeFetchSubscribers in useFileTree) — no signature change needed.
            dispatchTagEvent(env.event);
            break;
          // migration:status: deferred to Phase 2 retro;
          // unknown future events ignored without warning so they don't crash.
          default:
            break;
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        const delay = nextDelay(attempt);
        attempt++;
        setStatus("reconnecting"); // D-05 step (a) for the NEXT attempt
        reconnectTimer = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose fires next; nothing to do here.
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTree, setStatus, wsUrlFn]);
  // handlers consumed via handlersRef.current — intentionally NOT in deps.
}
