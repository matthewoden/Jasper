/**
 * filesApi — raw-fetch wrappers for OS-file operations (upload, delete, move).
 * Used by FileTree's sidebar drop target.
 *
 * Uses raw fetch + FormData rather than openapi-fetch because openapi-typescript
 * does not generate ergonomic file-field types for multipart/form-data requests.
 * Routes and response shapes remain contract-bound via OpenAPI.
 *
 * Target directory is passed as the `path` query parameter. URLSearchParams
 * encodes "/" as "%2F" so multi-segment paths survive the round-trip.
 * Empty string ("") = vault root.
 *
 * Errors (400, 403, 413) surface as a generic Error with `.status` so callers
 * can decide which toast to show.
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
  /**
   * Raw response body text so the FileTree drop-toast can show the backend's
   * actual error message rather than a generic catch-all.
   */
  body?: string;
}

export async function uploadFile(
  targetDir: string,
  file: File,
): Promise<UploadFileResult> {
  const formData = new FormData();
  formData.append("file", file);

  const qs = new URLSearchParams({ path: targetDir }).toString();
  const url = `/api/v1/files?${qs}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
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
    err.body = text;
    throw err;
  }

  return (await resp.json()) as UploadFileResult;
}

/**
 * deleteFile — DELETE /api/v1/files?path=<rel>.
 *
 * Server refuses .md files and directories; returns 204 on success.
 * Errors carry .status + .body so callers can surface the backend message.
 */
export async function deleteFile(path: string): Promise<void> {
  const qs = new URLSearchParams({ path }).toString();
  const url = `/api/v1/files?${qs}`;

  const resp = await fetch(url, {
    method: "DELETE",
    headers: {
      "X-Session-ID": generateOrLoadSessionId(),
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(
      `deleteFile failed: ${resp.status} ${text}`,
    ) as UploadFileError;
    err.status = resp.status;
    err.body = text;
    throw err;
  }
}

export interface MoveFileResult {
  path: string;
  name: string;
}

/**
 * moveFile — POST /api/v1/files/move {src_path, dst_path}.
 *
 * Both paths are relative under notes/. Server refuses .md files, refuses
 * overwrite (409), and validates both paths with the path-traversal pipeline.
 * Atomic via os.Rename on POSIX.
 */
export async function moveFile(
  srcPath: string,
  dstPath: string,
): Promise<MoveFileResult> {
  const resp = await fetch("/api/v1/files/move", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-ID": generateOrLoadSessionId(),
    },
    body: JSON.stringify({ src_path: srcPath, dst_path: dstPath }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(
      `moveFile failed: ${resp.status} ${text}`,
    ) as UploadFileError;
    err.status = resp.status;
    err.body = text;
    throw err;
  }

  return (await resp.json()) as MoveFileResult;
}
