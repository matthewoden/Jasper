/**
 * Attachment upload API. Uses raw fetch + FormData rather than openapi-fetch
 * because openapi-typescript does not generate ergonomic file-field types for
 * multipart/form-data requests. The route + response shape remain
 * contract-bound to api/openapi.yaml.
 */
import type { components } from "../api/schema";
import { generateOrLoadSessionId } from "./sessionId";

export type AttachmentUploadResult = components["schemas"]["AttachmentUploadResult"];

/** Thrown by uploadAttachment when the server returns HTTP 413 (file exceeds the 100 MB cap). */
export class AttachmentTooLargeError extends Error {
  constructor() {
    super("attachment exceeds 100 MB");
    this.name = "AttachmentTooLargeError";
  }
}

/**
 * uploadAttachment — POST /api/v1/attachments/{noteId}.
 *
 * Throws AttachmentTooLargeError on 413; throws a generic Error with the
 * status code for all other non-OK responses. The noteId is URL-encoded
 * via encodeURIComponent to handle UUIDs and special characters safely.
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
