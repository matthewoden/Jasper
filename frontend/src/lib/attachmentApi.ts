/**
 * attachmentApi.ts — Phase 7 Plan 10 / ATTACH-01..ATTACH-06.
 *
 * EXCEPTION: this module uses raw fetch + FormData rather than openapi-fetch,
 * because openapi-typescript does not generate ergonomic file-field types for
 * multipart/form-data requests (RESEARCH.md §Thread 5 §useAttachmentUpload).
 * The route + response shape are still contract-bound to api/openapi.yaml; a
 * smoke test verifies the response shape matches AttachmentUploadResult.
 */
import type { components } from "../api/schema";
import { generateOrLoadSessionId } from "./sessionId";

export type AttachmentUploadResult = components["schemas"]["AttachmentUploadResult"];

/**
 * AttachmentTooLargeError — thrown by uploadAttachment when the server
 * returns HTTP 413 (file exceeds the 100 MB cap, D-29).
 */
export class AttachmentTooLargeError extends Error {
  constructor() {
    super("attachment exceeds 100 MB");
    this.name = "AttachmentTooLargeError";
  }
}

/**
 * uploadAttachment — POST /api/v1/attachments/{noteId}.
 *
 * Builds a multipart/form-data body with the file under the key "file" and
 * returns the parsed AttachmentUploadResult on 200. Throws
 * AttachmentTooLargeError on 413; throws a generic Error with the status code
 * for all other non-OK responses.
 *
 * The noteId is URL-encoded to handle UUIDs and any special characters safely
 * (T-7-29 XSS mitigate via encodeURIComponent).
 */
export async function uploadAttachment(
  noteId: string,
  file: File
): Promise<AttachmentUploadResult> {
  const formData = new FormData();
  formData.append("file", file);

  const resp = await fetch(
    `/api/v1/attachments/${encodeURIComponent(noteId)}`,
    {
      method: "POST",
      headers: {
        // UAT-2 N8 fix: X-Session-ID propagation matches the typed openapi-fetch
        // client middleware (api/client.ts:31). Without this header the backend
        // broadcasts EventNoteUpdated with empty originSessionID, which
        // useSessionSync's WS filter (Pitfall 5) does NOT suppress — the
        // originating session sees its own event and triggers the conflict banner.
        // NOTE: do NOT set Content-Type here — fetch auto-generates the
        // multipart/form-data boundary from the FormData body.
        "X-Session-ID": generateOrLoadSessionId(),
      },
      body: formData,
    }
  );

  if (resp.status === 413) {
    throw new AttachmentTooLargeError();
  }
  if (!resp.ok) {
    throw new Error(`uploadAttachment: HTTP ${resp.status}`);
  }

  return (await resp.json()) as AttachmentUploadResult;
}
