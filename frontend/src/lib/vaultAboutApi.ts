/**
 * vaultAboutApi — typed wrapper around GET /vault/about (Phase 32 / SET3-04).
 * Mirrors getConfig's shape in useConfig.ts: never throws, returns
 * `{ data?, error? }` so the About pane renders an error row instead of
 * an unhandled rejection.
 */
import { client } from "../api/client";
import type { components } from "../api/schema";

export type VaultAbout = components["schemas"]["VaultAbout"];
export type ApiError = { code: string; message: string; status: number };

function asApiError(error: unknown, status: number): ApiError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const e = error as { code: unknown; message: unknown };
    return {
      code: typeof e.code === "string" ? e.code : "unknown",
      message: typeof e.message === "string" ? e.message : "request failed",
      status,
    };
  }
  return { code: "unknown", message: "request failed", status };
}

export async function getVaultAbout(): Promise<{ data?: VaultAbout; error?: ApiError }> {
  // The transport itself rejects on a connection reset or the vault hot-swap
  // 503 window; without this catch the "never throws" contract above is a
  // comment, not a guarantee, and callers get an unhandled rejection.
  try {
    const res = await client.GET("/vault/about");
    if (!res.data) {
      const status = (res.response as { status?: number } | undefined)?.status ?? 0;
      return { error: asApiError(res.error, status) };
    }
    return { data: res.data };
  } catch (err) {
    return { error: { code: "network", message: String(err), status: 0 } };
  }
}
