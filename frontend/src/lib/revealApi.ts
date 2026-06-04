/**
 * revealApi — typed wrapper around POST /api/v1/reveal (SHARE-01, D-26).
 *
 * Per CONTEXT.md API-03: the frontend NEVER hand-writes a request shape.
 * All API calls route through the typed openapi-fetch client.
 *
 * Backend (Plan 08-05, extended in v1.1 for native Linux) dispatches per
 * host platform:
 *   - macOS  → `open -R <abs>`, 200 {platform: "darwin"}
 *   - WSL2   → `wslpath -w` + `explorer.exe /select,...`, 200 {platform: "wsl2"}
 *   - Linux  → `xdg-open <parent_dir>`, 200 {platform: "linux"} — xdg-open
 *              cannot pre-select a target file, so the parent directory opens
 *              in the default file manager (closes D-28 / SHARE-01).
 *   - Other  → 4xx/5xx Error envelope
 *
 * This wrapper preserves the {ok, platform?, status, errorMessage?} shape so
 * useReveal can pick the correct toast (Surface 5) without re-parsing the
 * backend response.
 */

import { client } from "../api/client";

export interface RevealResult {
  /** true on 2xx; false on every non-2xx outcome (4xx / 5xx / 501). */
  ok: boolean;
  /** Present iff ok === true. Platform that handled the dispatch (D-26/D-28). */
  platform?: "darwin" | "wsl2" | "linux";
  /** HTTP status — used to specialize the 501 toast copy in useReveal. */
  status: number;
  /** Server-provided message string when error is present (T-08-25: never HTML, always plain text). */
  errorMessage?: string;
}

/**
 * Open the host OS file manager focused on a vault-relative file or folder.
 *
 * The caller (useReveal) translates the result into a toast — this wrapper
 * intentionally does NOT throw, since every error path renders a friendly toast
 * rather than bubbling an exception. Distinguishing 501 from generic 5xx requires
 * the raw HTTP status, which openapi-fetch surfaces via the `response` object.
 *
 * @param path - Vault-relative path under notes/ (e.g. "projects/jasper/note.md")
 */
export async function revealPath(path: string): Promise<RevealResult> {
  const { data, error, response } = await client.POST("/reveal", {
    body: { path },
  });
  if (error || !data) {
    // Generated Error envelope is `{ code: string, message: string }`. Extract
    // the message defensively — older spec drafts shipped a bare-string error
    // shape and we don't want a property-access TypeError to swallow the
    // toast.
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
