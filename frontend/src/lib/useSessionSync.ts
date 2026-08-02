import { useEffect, useRef } from "react";
import { generateOrLoadSessionId } from "./sessionId";
import { nextDelay } from "./backoff";
import { useTreeStore } from "./useTreeStore";
import { treeResource } from "./treeApi";
import { publish } from "./resources";
import type { components } from "../api/schema";

type WSEnvelope = components["schemas"]["WSEnvelope"];
type WSNoteUpdatedPayload = components["schemas"]["WSNoteUpdatedPayload"];
type WSNoteDeletedPayload = components["schemas"]["WSNoteDeletedPayload"];
type WSReindexCompletePayload = components["schemas"]["WSReindexCompletePayload"];
type WSLinksRewrittenPayload = components["schemas"]["WSLinksRewrittenPayload"];

export interface SessionSyncHandlers {
  onNoteUpdated: (p: WSNoteUpdatedPayload) => void;
  onNoteDeleted: (p: WSNoteDeletedPayload) => void;
  onReindexStarted: () => void;
  onReindexComplete: (p: WSReindexCompletePayload) => void;
  /**
   * Called when a note rename's wiki-link rewrite completes. Cross-tab only —
   * source tab is suppressed by the origin_session_id filter.
   * Optional; App.tsx may use this to surface a RenameRewriteErrorBanner on partial failure.
   */
  onLinksRewritten?: (p: WSLinksRewrittenPayload) => void;
  /**
   * Called when the server broadcasts vault.switching. The SPA should mount
   * the VaultSwitchOverlay and schedule the 10s failsafe reload.
   * Payload contains target_path + target_display_name.
   */
  onVaultSwitching?: (p: { target_path: string; target_display_name: string }) => void;
  /**
   * Called when the server broadcasts vault.switched. The SPA should call
   * window.location.reload() to reconnect to the new vault's hub.
   */
  onVaultSwitched?: () => void;
}

/** Builds the ws:// or wss:// URL for the WS upgrade. Dependency-injectable for tests. */
function defaultWsUrl(sid: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/v1/ws?session_id=${encodeURIComponent(sid)}`;
}

export interface UseSessionSyncOptions {
  /** Test seam: override the URL builder so mock-socket can intercept. */
  wsUrlFn?: (sid: string) => string;
}

/**
 * WebSocket session-sync hook. Mount once at App root. Owns the WS connection,
 * the connection-status state machine, the reconnect loop, and inbound-event routing.
 *
 * Reconnect sequence: setStatus("reconnecting") → await an explicit tree
 * invalidation on open → resume processing inbound events →
 * setStatus("connected"). A reconnect is a "we may have missed events"
 * signal, so it invalidates rather than publishes — the same reasoning
 * that governs every other resource, applied at the transport layer.
 *
 * Security: inbound `origin_session_id` is treated as opaque — never rendered
 * to the DOM. Used only for equality compare against own session_id to suppress
 * self-originated events.
 *
 * All listeners are attached SYNCHRONOUSLY before any await after `new WebSocket(...)`,
 * so no inbound message is lost on a slow CPU between construction and listener setup.
 *
 * Empty origin_session_id ("") is the protocol signal for server-originated events
 * (reindex:*, migration:status) — these bypass the origin filter and reach every tab.
 */
export function useSessionSync(
  handlers: SessionSyncHandlers,
  opts: UseSessionSyncOptions = {},
): void {
  const setStatus = useTreeStore((s) => s.setConnectionStatus);
  const setForceWsReconnect = useTreeStore((s) => s.setForceWsReconnect);
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

      ws.onopen = async () => {
        if (cancelled) return;
        attempt = 0;
        try {
          await treeResource.invalidate();
        } catch {
          // invalidate() errors are surfaced via treeResource's own error
          // snapshot; we still flip to connected so events resume.
        }
        if (cancelled) return;
        setStatus("connected");
      };

      ws.onmessage = (e) => {
        let env: WSEnvelope;
        try {
          env = JSON.parse(e.data as string) as WSEnvelope;
        } catch {
          return;
        }
        if (env.origin_session_id !== "" && env.origin_session_id === sessionId) {
          return;
        }
        switch (env.event) {
          case "session:assigned":
            break;
          case "note:updated":
            handlersRef.current.onNoteUpdated(
              env.payload as WSNoteUpdatedPayload,
            );
            publish("note:updated");
            break;
          case "note:deleted":
            handlersRef.current.onNoteDeleted(
              env.payload as WSNoteDeletedPayload,
            );
            break;
          case "note:created":
            publish("note:created");
            break;
          // treeResource declares each of these seven events in its own
          // invalidatedBy list (treeApi.ts), so publishing is exactly one
          // invalidate for whoever is subscribed, and zero requests when
          // nothing is mounted.
          case "note:moved":
            publish("note:moved");
            break;
          case "folder:created":
            publish("folder:created");
            break;
          case "folder:deleted":
            publish("folder:deleted");
            break;
          case "folder:moved":
            publish("folder:moved");
            break;
          case "file:created":
            publish("file:created");
            break;
          case "file:deleted":
            publish("file:deleted");
            break;
          case "file:moved":
            publish("file:moved");
            break;
          case "reindex:started":
            handlersRef.current.onReindexStarted();
            break;
          case "reindex:complete":
            handlersRef.current.onReindexComplete(
              env.payload as WSReindexCompletePayload,
            );
            // A reindex can discover files added/removed on disk outside the
            // app (external edits, manual Refresh). treeResource is
            // invalidatedBy reindex:complete, so this publish covers the
            // note/folder mutation cases above too.
            publish("reindex:complete");
            break;
          case "tags:updated":
          case "tags:rewritten":
            publish(env.event);
            break;
          case "links:rewritten":
            publish("links:rewritten");
            handlersRef.current.onLinksRewritten?.(env.payload as WSLinksRewrittenPayload);
            break;
          case "mcp:grant_changed":
            publish("mcp:grant_changed");
            break;
          case "bookmark:changed":
            publish("bookmark:changed");
            break;
          case "workspace:changed":
            publish("workspace:changed");
            break;
          case "vault.switching": {
            const vaultSwitchingPayload = env.payload as {
              target_path: string;
              target_display_name: string;
            };
            handlersRef.current.onVaultSwitching?.(vaultSwitchingPayload);
            break;
          }
          case "vault.switched": {
            handlersRef.current.onVaultSwitched?.();
            break;
          }
          default:
            break;
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        const delay = nextDelay(attempt);
        attempt++;
        setStatus("reconnecting");
        reconnectTimer = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose fires immediately after onerror; nothing additional to do here.
      };
    };

    const forceReconnect = () => {
      if (cancelled) return;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      attempt = 0;
      connect();
    };
    setForceWsReconnect(forceReconnect);

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ws?.close();
      setForceWsReconnect(() => {});
    };
  }, [setStatus, setForceWsReconnect, wsUrlFn]);
  // handlers consumed via handlersRef.current — stable ref avoids re-mounting the WS on every render.
}
