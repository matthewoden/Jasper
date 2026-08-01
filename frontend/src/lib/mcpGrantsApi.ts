/**
 * mcpGrantsApi — typed wrappers over the MCP grant endpoints.
 * All calls route through the openapi-fetch client; no hand-written request shapes.
 *
 * Endpoints:
 *   GET    /api/v1/mcp/grants                → mcpGrantsResource (module-private listGrants fetcher)
 *   POST   /api/v1/mcp/grants                → postGrant(path, level): McpGrant
 *   DELETE /api/v1/mcp/grants?path=<encoded> → deleteGrant(path): void
 *
 * Each wrapper throws on non-2xx so callers can use try/catch.
 */

import { client } from "../api/client";
import { createResource } from "./resources";
import type { McpGrant } from "./useTreeStore";

/**
 * List all MCP write grants. Throws on error — the resource layer's own
 * preserve-last-good-value-on-failure policy is now responsible for the
 * "don't wipe previously-cached grants on a transient hiccup" contract that
 * this fetcher used to implement itself by swallowing and returning [].
 */
async function listGrants(): Promise<McpGrant[]> {
  const { data, error } = await client.GET("/mcp/grants");
  if (error || !data) {
    const msg =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : JSON.stringify(error);
    throw new Error("listGrants: " + msg);
  }
  return (data.grants ?? []) as McpGrant[];
}

export const mcpGrantsResource = createResource("mcpGrants", listGrants, {
  mode: "cached",
  invalidatedBy: ["mcp:grant_changed"],
});

/**
 * Grant (or upgrade / downgrade) MCP write access for a folder. Backend
 * is idempotent — POST with an existing folder_path updates the level
 * and refreshes granted_at; POST with a new folder_path creates the row.
 * Throws on non-2xx so the caller's catch can surface an error toast.
 */
export async function postGrant(
  folderPath: string,
  level: 1 | 2,
): Promise<McpGrant> {
  const { data, error } = await client.POST("/mcp/grants", {
    body: { folder_path: folderPath, level },
  });
  if (error || !data) {
    const msg =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "grant failed";
    throw new Error(msg);
  }
  return data as McpGrant;
}

/**
 * Revoke MCP write access for a folder. Backend returns 204 on success
 * or 404 if no grant exists for the given folder_path (we treat 404 as
 * a soft failure — the row is already gone from the user's perspective).
 */
export async function deleteGrant(folderPath: string): Promise<void> {
  const { error } = await client.DELETE("/mcp/grants", {
    params: { query: { path: folderPath } },
  });
  if (error) {
    const msg =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "revoke failed";
    throw new Error(msg);
  }
}
