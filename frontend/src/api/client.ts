import createClient from "openapi-fetch";
import type { paths } from "./schema";

/**
 * The single typed API client for the entire frontend.
 * Per CONTEXT.md API-03: the frontend NEVER hand-writes request shapes.
 *
 * baseUrl is "/api/v1" because the OpenAPI spec declares
 * `servers: - url: /api/v1`, but openapi-fetch does NOT auto-prepend
 * the spec's servers — paths in the typed `paths` object are the
 * post-servers segments (e.g. `/notes/{id}`). So the client must
 * supply the prefix itself.
 *   - In dev, Vite proxies /api → http://127.0.0.1:3001 (backend).
 *   - In prod, the Go binary serves both SPA + API on the same origin
 *     and registers handlers under r.Route("/api/v1", ...).
 */
export const client = createClient<paths>({ baseUrl: "/api/v1" });
