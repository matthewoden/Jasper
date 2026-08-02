/**
 * Admin API wrappers. All calls route through the typed openapi-fetch client —
 * no hand-written request shapes.
 */

import { client } from "../api/client";
import { createResource } from "./resources";

function fetchAdminStatus() {
  return client.GET("/admin/status");
}

// reindex:complete is a real WS event and useMigrationStatus already exposes
// a post-reindex refresh() — declaring the event is more honest than
// claiming this data never changes.
export const adminStatusResource = createResource("adminStatus", fetchAdminStatus, {
  mode: "cached",
  invalidatedBy: ["reindex:complete"],
});

/** Fetch the migration runner state. Wire URL: GET /api/v1/admin/status */
export function getAdminStatus() {
  return adminStatusResource.read();
}

/**
 * Trigger a re-index. Wire URL: POST /api/v1/admin/reindex
 */
export function postAdminReindex(mode: "full" | "incremental" = "full") {
  return client.POST("/admin/reindex", { body: { mode } });
}
