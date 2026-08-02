/**
 * Per-tab session_id, persisted in sessionStorage — NOT localStorage, since every
 * tab is its own session.
 *
 * SINGLE source of truth for both the X-Session-ID header and the WS upgrade's
 * ?session_id param. Without an exact match between the two, the server cannot
 * origin-filter broadcasts.
 *
 * The value is opaque and never rendered to the DOM.
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
