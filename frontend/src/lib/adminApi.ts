/**
 * Admin API wrappers. All calls route through the typed openapi-fetch client —
 * no hand-written request shapes.
 */

import { client } from "../api/client";

/** Fetch the migration runner state. Wire URL: GET /api/v1/admin/status */
export function getAdminStatus() {
  return client.GET("/admin/status");
}

/**
 * Trigger a re-index. Wire URL: POST /api/v1/admin/reindex
 */
export function postAdminReindex(mode: "full" | "incremental" = "full") {
  return client.POST("/admin/reindex", { body: { mode } });
}
