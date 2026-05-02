import createClient from "openapi-fetch";
import type { paths } from "./schema";

/**
 * The single typed API client for the entire frontend.
 * Per CONTEXT.md API-03: the frontend NEVER hand-writes request shapes.
 * baseUrl is "/" because:
 *   - in dev, Vite proxies /api → http://127.0.0.1:3001 (backend)
 *   - in prod, the Go binary serves both SPA + API on the same origin
 */
export const client = createClient<paths>({ baseUrl: "/" });
