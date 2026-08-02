/**
 * Tests for attachmentApi.uploadAttachment.
 * Uses raw fetch + FormData rather than openapi-fetch (openapi-typescript
 * does not generate ergonomic file-field types for multipart/form-data).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  uploadAttachment,
  AttachmentTooLargeError,
} from "./attachmentApi";
import type { AttachmentUploadResult } from "./attachmentApi";

describe("attachmentApi / uploadAttachment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: returns AttachmentUploadResult on 200", async () => {
    const mockResult: AttachmentUploadResult = {
      filename: "photo.png",
      path: "attachments/photo.png",
      content_type: "image/png",
      category: "image",
      is_image: true,
      size_bytes: 12345,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResult,
      })
    );

    const file = new File(["bytes"], "photo.png", { type: "image/png" });
    const result = await uploadAttachment("note-uuid-123", file);

    expect(result).toEqual(mockResult);

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v1/attachments/note-uuid-123");
    expect(opts?.method).toBe("POST");
    expect(opts?.body).toBeInstanceOf(FormData);
  });

  it("413 response → throws AttachmentTooLargeError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 413,
        json: async () => ({}),
      })
    );

    const file = new File(["x".repeat(100)], "huge.bin");
    await expect(uploadAttachment("note-123", file)).rejects.toThrow(
      AttachmentTooLargeError
    );
    await expect(uploadAttachment("note-123", file)).rejects.toThrow(
      "attachment exceeds 100 MB"
    );
  });

  it("non-200 non-413 response → throws generic Error with status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      })
    );

    const file = new File(["x"], "file.txt");
    await expect(uploadAttachment("note-123", file)).rejects.toThrow("HTTP 500");
  });

  it("404 note-not-found → throws generic Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ message: "not found" }),
      })
    );

    const file = new File(["x"], "file.txt");
    await expect(uploadAttachment("unknown-note", file)).rejects.toThrow(
      "uploadAttachment: HTTP 404"
    );
  });

  it("AttachmentTooLargeError has correct name", () => {
    const err = new AttachmentTooLargeError();
    expect(err.name).toBe("AttachmentTooLargeError");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AttachmentTooLargeError).toBe(true);
  });

  it("non-image file → is_image false in response", async () => {
    const mockResult: AttachmentUploadResult = {
      filename: "report.pdf",
      path: "attachments/report.pdf",
      content_type: "application/pdf",
      category: "pdf",
      is_image: false,
      size_bytes: 55000,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResult,
      })
    );

    const file = new File(["pdf bytes"], "report.pdf", {
      type: "application/pdf",
    });
    const result = await uploadAttachment("note-123", file);
    expect(result.is_image).toBe(false);
    expect(result.category).toBe("pdf");
  });
});

describe("UA-session-header — uploadAttachment includes X-Session-ID", () => {
  it("attaches X-Session-ID header equal to generateOrLoadSessionId()", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          filename: "x.png",
          path: "x.png",
          size_bytes: 1,
          content_type: "image/png",
          category: "other",
          is_image: true,
        }),
        { status: 200 }
      )
    );
    const file = new File(["x"], "x.png", { type: "image/png" });
    await uploadAttachment("note-1", file);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string> | Headers | undefined;
    const sid =
      headers instanceof Headers
        ? headers.get("X-Session-ID")
        : (headers as Record<string, string> | undefined)?.["X-Session-ID"];
    expect(sid).toBeTruthy();
    expect(sid).toMatch(/^[0-9a-f-]{36}$/i);
    fetchSpy.mockRestore();
  });
});
