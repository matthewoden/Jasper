/**
 * revealApi wraps POST /reveal. The backend dispatches per platform; on Linux
 * xdg-open cannot pre-select a file, so the parent directory opens instead.
 *
 * Returns {ok, platform?, status, errorMessage?} so useReveal can pick a toast
 * without re-parsing the response.
 */

import { client } from "../api/client";

export interface RevealResult {
  /** true on 2xx; false on every non-2xx outcome (4xx / 5xx / 501). */
  ok: boolean;
  /** Present iff ok === true. Platform that handled the dispatch. */
  platform?: "darwin" | "wsl2" | "linux";
  /** HTTP status — used to specialize the 501 toast copy in useReveal. */
  status: number;
  /** Server-provided message string when error is present (never HTML, always plain text). */
  errorMessage?: string;
}

/**
 * Deliberately does not throw: every error path renders a toast rather than
 * bubbling. Distinguishing 501 from a generic 5xx needs the raw status, which
 * openapi-fetch exposes on `response`.
 */
export async function revealPath(
  path: string,
  scope: "note" | "vaultRoot" = "note",
): Promise<RevealResult> {
  const { data, error, response } = await client.POST("/reveal", {
    body: { path, scope },
  });
  if (error || !data) {
    const errObj = error as { message?: string } | undefined;
    const message =
      errObj && typeof errObj.message === "string" && errObj.message.length > 0
        ? errObj.message
        : `HTTP ${response.status}`;
    return {
      ok: false,
      status: response.status,
      errorMessage: message,
    };
  }
  return {
    ok: true,
    platform: data.platform,
    status: response.status,
  };
}

/**
 * Open the host OS file manager on the vault's own data directory (About
 * pane). The server ignores the request path entirely in this scope, so
 * `"."` is a placeholder, not a real path — see RevealRequest.scope in the
 * OpenAPI schema.
 */
export async function revealVaultRoot(): Promise<RevealResult> {
  return revealPath(".", "vaultRoot");
}
