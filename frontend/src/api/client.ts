import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema";
import { generateOrLoadSessionId } from "../lib/sessionId";

/**
 * The single typed API client. The frontend NEVER hand-writes request shapes
 * (API-03).
 *
 * baseUrl must be supplied here: openapi-fetch does NOT prepend the spec's
 * `servers` entry, so the typed paths are only the post-servers segments.
 *
 * sessionMiddleware attaches X-Session-ID to every request, using the SAME
 * generateOrLoadSessionId as the WS upgrade — server-side origin filtering
 * depends on the two matching.
 *
 * SECURITY: session_id is opaque — never rendered to the DOM, never logged.
 */
const sessionMiddleware: Middleware = {
  async onRequest({ request }) {
    request.headers.set("X-Session-ID", generateOrLoadSessionId());
    return request;
  },
};

export const client = createClient<paths>({ baseUrl: "/api/v1" });
client.use(sessionMiddleware);
