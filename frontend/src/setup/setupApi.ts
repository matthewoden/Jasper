/**
 * setupApi — typed openapi-fetch wrappers around the first-run wizard
 * endpoints introduced in Plan 08-01 / 08-02:
 *
 *   - GET  /api/v1/setup/status               → SetupStatus
 *   - POST /api/v1/setup/validate-data-dir    → SetupValidateResponse
 *   - POST /api/v1/setup                       → SetupResponse
 *
 * Plan 08-04 Task 1.
 *
 * The setup endpoints don't go through the X-Session-ID middleware
 * meaningfully (there's no session before setup), but reusing the
 * shared `client` keeps the baseUrl ("/api/v1") consistent and lets
 * openapi-fetch infer body/response types from the regenerated
 * `schema.d.ts`.
 *
 * Notes:
 *  - validateDataDir always resolves on 200 — the backend returns
 *    { valid: false, code, message } in the response body for the four
 *    D-08 refusal cases. The wrapper does NOT throw on `valid: false`;
 *    the caller distinguishes valid/invalid by reading the response.
 *  - submitSetup returns void on success; on 400/500 it throws an Error
 *    whose message is a JSON-encoded form of the backend Error payload
 *    so the wizard can surface `{server_message}` in the locked toast
 *    copy (UI-SPEC §Copywriting Contract submit error).
 *  - All three wrappers accept an optional AbortSignal so the wizard
 *    can cancel in-flight requests on rapid keystrokes (T-08-18 race
 *    protection).
 */
import { client } from "../api/client";
import type { components } from "../api/schema";

export type SetupRequest = components["schemas"]["SetupRequest"];
export type SetupValidateResponse = components["schemas"]["SetupValidateResponse"];
export type SetupStatus = components["schemas"]["SetupStatus"];
export type McpGrantSeed = components["schemas"]["McpGrantSeed"];

export async function getSetupStatus(signal?: AbortSignal): Promise<SetupStatus> {
  const { data, error } = await client.GET("/setup/status", { signal });
  if (error || !data) {
    throw new Error("getSetupStatus: request failed");
  }
  return data;
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
