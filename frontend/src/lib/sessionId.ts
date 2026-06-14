/**
 * Per-tab session_id (SYNC-01, SYNC-02). Generated once on first call
 * and persisted in sessionStorage (per-tab, NOT localStorage — every
 * tab is its own session per DESIGN.md §6.1).
 *
 * SINGLE source of truth — both the openapi-fetch sessionMiddleware
 * (X-Session-ID header on every mutating HTTP request) AND
 * useSessionSync (the WS upgrade query param ?session_id=<sid>) call
 * generateOrLoadSessionId(). This guarantees the X-Session-ID header
 * value matches the WS connection's session_id exactly — without that
 * match, the server cannot origin-filter broadcasts.
 *
 * SECURITY: the value is opaque. It is never rendered to the
 * DOM. The server applies a 128-char length cap on the WS handshake
 * side; UUIDs are 36 chars so this is always safe.
 */
const STORAGE_KEY = "jasper.sessionId";

export function generateOrLoadSessionId(): string {
  let sid = sessionStorage.getItem(STORAGE_KEY);
  if (!sid) {
    sid = crypto.randomUUID();
    sessionStorage.setItem(STORAGE_KEY, sid);
  }
  return sid;
}
