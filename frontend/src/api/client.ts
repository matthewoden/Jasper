import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema";
import { generateOrLoadSessionId } from "../lib/sessionId";

/**
 * The single typed API client for the entire frontend.
 * Per CONTEXT.md API-03: the frontend NEVER hand-writes request shapes.
 *
 * baseUrl is "/api/v1" because the OpenAPI spec declares
 * `servers: - url: /api/v1`, but openapi-fetch does NOT auto-prepend
 * the spec's servers — paths in the typed `paths` object are the
 * post-servers segments (e.g. `/notes/{id}`). So the client must
 * supply the prefix itself.
 *   - In dev, Vite proxies /api → http://127.0.0.1:6683 (or whatever
 *     scripts/port.sh resolves; see frontend/vite.config.ts).
 *   - In prod, the Go binary serves both SPA + API on the same origin
 *     and registers handlers under r.Route("/api/v1", ...).
 *
 * SYNC-02 — sessionMiddleware attaches X-Session-ID to every request
 * via the openapi-fetch v0.17 middleware API. Every typed wrapper
 * (notesApi, treeApi, adminApi, foldersApi) inherits this automatically
 * because they all share `client`.
 *
 * Pitfall 1: the same generateOrLoadSessionId() helper is read by
 * useSessionSync's WS upgrade — guarantees the X-Session-ID header
 * value MATCHES the WS connection's session_id, which is required for
 * server-side origin filtering to work.
 *
 * SECURITY: session_id is an opaque UUID — never rendered
 * to the DOM, never logged, just threaded through headers.
 */
const sessionMiddleware: Middleware = {
  async onRequest({ request }) {
    request.headers.set("X-Session-ID", generateOrLoadSessionId());
    return request;
  },
};

export const client = createClient<paths>({ baseUrl: "/api/v1" });
client.use(sessionMiddleware);
