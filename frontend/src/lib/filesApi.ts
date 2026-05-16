/**
 * filesApi — typed wrapper around POST /api/v1/files?path=... (Plan 07-34).
 *
 * Used by FileTree's sidebar OS-file drop target. Mirrors uploadAttachment
 * (attachmentApi.ts) — multipart/form-data with field 'file', includes
 * X-Session-ID header for the WS origin filter (UAT-2 N8 pattern).
 *
 * EXCEPTION (matches attachmentApi.ts): we use raw fetch + FormData rather
 * than openapi-fetch because openapi-typescript does not generate ergonomic
 * file-field types for multipart/form-data requests. The route + response
 * shape are still contract-bound via OpenAPI.
 *
 * WIRE FORMAT (per the 07-34 contract override + 07-32a SUMMARY): the
 * target directory is passed as the `path` QUERY PARAMETER, not a path
 * segment. URLSearchParams encodes "/" as "%2F" so multi-segment dirs
 * survive the round-trip; the server's path-traversal pipeline canonicalizes
 * back relative to notes/. Empty string ("") = vault root.
 *
 * Errors: HTTP 400 (invalid path / .md upload), 403 (symlink rejected),
 * 413 (>100MB) all surface as a generic Error with `.status` set so callers
 * can distinguish — the FileTree drop handler uses this to decide which
 * toast (if any) to show.
 */
import { generateOrLoadSessionId } from "./sessionId";

export interface UploadFileResult {
  path: string;
  name: string;
  size_bytes: number;
  content_type?: string;
}

export interface UploadFileError extends Error {
  status?: number;
}

export async function uploadFile(
  targetDir: string,
  file: File,
): Promise<UploadFileResult> {
  const formData = new FormData();
  formData.append("file", file);

  // URLSearchParams gives us correct application/x-www-form-urlencoded
  // escaping for the path query parameter — including "/" → "%2F" for
  // multi-segment target dirs. The server decodes back to the original
  // multi-segment string before the path-traversal pipeline runs.
  const qs = new URLSearchParams({ path: targetDir }).toString();
  const url = `/api/v1/files?${qs}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      // X-Session-ID propagation matches uploadAttachment (UAT-2 N8 fix);
      // the backend uses this to suppress self-broadcast on the WS hub.
      // Do NOT set Content-Type — fetch generates the multipart boundary
      // from the FormData body automatically.
      "X-Session-ID": generateOrLoadSessionId(),
    },
    body: formData,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(
      `uploadFile failed: ${resp.status} ${text}`,
    ) as UploadFileError;
    err.status = resp.status;
    throw err;
  }

  return (await resp.json()) as UploadFileResult;
}
