/**
 * setupApi — typed openapi-fetch wrappers for the first-run wizard endpoints:
 *   - GET  /api/v1/setup/status
 *   - POST /api/v1/setup/validate-data-dir
 *   - POST /api/v1/setup
 *
 * Reuses the shared `client` to keep the baseUrl consistent even though
 * X-Session-ID is not meaningful before setup completes.
 *
 * validateDataDir always resolves (backend returns { valid: false, ... } in the
 * body for refusal cases — the wrapper never throws on valid: false).
 * submitSetup throws on 400/500 so the wizard can surface the server message.
 * All wrappers accept an optional AbortSignal for rapid-keystroke cancellation.
 */
import { client } from "../api/client";
import type { components } from "../api/schema";
import { createResource } from "../lib/resources";

export type SetupRequest = components["schemas"]["SetupRequest"];
export type SetupValidateResponse = components["schemas"]["SetupValidateResponse"];
export type SetupStatus = components["schemas"]["SetupStatus"];
export type McpGrantSeed = components["schemas"]["McpGrantSeed"];

async function fetchSetupStatus(): Promise<SetupStatus> {
  const { data, error } = await client.GET("/setup/status");
  if (error || !data) {
    throw new Error("getSetupStatus: request failed");
  }
  return data;
}

// pass-through, not cached: SetupApp runs pre-vault with no WebSocket, so
// there is no invalidation channel to declare (D-15 as amended). /setup is
// deliberately registered anyway — D-18's "zero exemptions" means every GET
// lives in the resource layer even where caching offers no benefit yet.
export const setupStatusResource = createResource("setupStatus", fetchSetupStatus, {
  mode: "pass-through",
});

export async function getSetupStatus(signal?: AbortSignal): Promise<SetupStatus> {
  // A caller-supplied signal (rapid-keystroke cancellation) bypasses the
  // shared resource — the resource layer has no per-call cancellation
  // concept, and coalescing an abortable call with a non-abortable one
  // would let an aborted caller's signal cancel a request other callers
  // are still waiting on.
  if (signal) {
    const { data, error } = await client.GET("/setup/status", { signal });
    if (error || !data) {
      throw new Error("getSetupStatus: request failed");
    }
    return data;
  }
  return setupStatusResource.read();
}

export async function validateDataDir(
  path: string,
  signal?: AbortSignal,
): Promise<SetupValidateResponse> {
  const { data, error } = await client.POST("/setup/validate-data-dir", {
    body: { path },
    signal,
  });
  if (error || !data) {
    throw new Error("validateDataDir: request failed");
  }
  return data;
}

export async function submitSetup(req: SetupRequest): Promise<void> {
  const { error } = await client.POST("/setup", { body: req });
  if (error) {
    const msg =
      error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : "";
    throw new Error(msg || JSON.stringify(error));
  }
}
