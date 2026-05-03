/**
 * Admin-surface counterpart to notesApi.ts. Phase 2 has two endpoints
 * (GET /admin/status, POST /admin/reindex). Phase 4 will swap the GET
 * /admin/status path for a WebSocket subscription, but useMigrationStatus()'s
 * shape is locked so components don't change.
 *
 * Per CONTEXT.md API-03: the frontend NEVER hand-writes a request shape.
 * Every call routes through the typed `client` (openapi-fetch).
 */

import { client } from "../api/client";

/**
 * Fetch the migration runner state. Backs the Surface 1 banner via the
 * useMigrationStatus() hook.
 *
 * Wire URL: GET /api/v1/admin/status
 */
export function getAdminStatus() {
  return client.GET("/admin/status");
}

/**
 * Trigger a re-index. Phase 2 always passes mode="full" from the
 * Reset-and-rebuild dialog (Surface 2 → Surface 3). The "incremental"
 * mode is reserved for Phase 3's TREE-11 Refresh-button path; same
 * endpoint, same wrapper.
 *
 * Wire URL: POST /api/v1/admin/reindex
 */
export function postAdminReindex(mode: "full" | "incremental" = "full") {
  return client.POST("/admin/reindex", { body: { mode } });
}
