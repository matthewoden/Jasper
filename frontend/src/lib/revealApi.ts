/**
 * revealApi — typed wrapper around POST /api/v1/reveal.
 * All calls route through the typed openapi-fetch client.
 *
 * Backend dispatches per host platform:
 *   - macOS  → `open -R <abs>`, 200 {platform: "darwin"}
 *   - WSL2   → `wslpath -w` + `explorer.exe /select,...`, 200 {platform: "wsl2"}
 *   - Linux  → `xdg-open <parent_dir>`, 200 {platform: "linux"} — xdg-open
 *              cannot pre-select a file, so the parent directory opens instead.
 *   - Other  → 4xx/5xx error envelope
 *
 * Preserves {ok, platform?, status, errorMessage?} so useReveal can pick the
 * correct toast without re-parsing the backend response.
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
    body: { path, scope: "note" },
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
