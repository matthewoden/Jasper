/**
 * filesApi.test.ts — Plan 07-34 / UAT-3 N2.
 *
 * Tests cover:
 *   - FA-1 happy path → POST /api/v1/files?path=<encoded> with multipart body
 *   - FA-2 returns the parsed FileNode-shaped response on 201
 *   - FA-3 413 from server → throws Error with .status = 413
 *
 * Note: per the 07-34 contract override + 07-32a SUMMARY, the wire format
 * is QUERY-PARAMETER (?path=) NOT path-segment (/files/{path}). Co-located
 * with GetFile (Plan 07-32a) at the same /files endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadFile, type UploadFileResult } from "./filesApi";

describe("filesApi.uploadFile (Plan 07-34)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // FA-1: target dir is encoded into the query param.
  it("FA-1: POSTs to /api/v1/files?path=<encoded targetDir> with multipart body", async () => {
    const mockResult: UploadFileResult = {
      path: "gallery/photo.png",
      name: "photo.png",
      size_bytes: 12345,
      content_type: "image/png",
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(mockResult), { status: 201 }),
      );

    const file = new File(["bytes"], "photo.png", { type: "image/png" });
    const result = await uploadFile("gallery", file);

    expect(result).toEqual(mockResult);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    // QUERY-PARAMETER wire format (matches GET /files/?path=...).
    expect(url).toBe("/api/v1/files?path=gallery");
    expect(opts?.method).toBe("POST");
    expect(opts?.body).toBeInstanceOf(FormData);
    // X-Session-ID is propagated (matches uploadAttachment pattern; see UAT-2 N8).
    const headers = opts?.headers as Record<string, string> | Headers | undefined;
    const sid =
      headers instanceof Headers
        ? headers.get("X-Session-ID")
        : (headers as Record<string, string> | undefined)?.["X-Session-ID"];
    expect(sid).toBeTruthy();
  });

  // FA-1b: empty target dir = vault root → ?path=
  it("FA-1b: empty targetDir means vault root → ?path=", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ path: "photo.png", name: "photo.png", size_bytes: 1 }),
          { status: 201 },
        ),
      );

    const file = new File(["bytes"], "photo.png");
    await uploadFile("", file);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/v1/files?path=");
  });

  // FA-1c: nested target dir with slash is encoded by-segment so `/` survives
  // (the backend's path-traversal pipeline canonicalizes it relative to notes/).
  it("FA-1c: nested targetDir 'a/b' encodes to ?path=a%2Fb (default URLSearchParams)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ path: "a/b/x.png", name: "x.png", size_bytes: 1 }),
          { status: 201 },
        ),
      );
    const file = new File(["x"], "x.png");
    await uploadFile("a/b", file);
    // URLSearchParams encodes "/" as %2F. The server's `path` query parser
    // decodes it back to "a/b" before the path-traversal pipeline runs.
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/v1/files?path=a%2Fb");
  });

  // FA-2: 201 returns the parsed body verbatim.
  it("FA-2: 201 returns the parsed FileNode-shaped result", async () => {
    const mockResult: UploadFileResult = {
      path: "photo-1.png",
      name: "photo-1.png",
      size_bytes: 99,
      content_type: "image/png",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResult), { status: 201 }),
    );
    const file = new File(["x"], "photo.png");
    const result = await uploadFile("", file);
    expect(result.name).toBe("photo-1.png");
    expect(result.path).toBe("photo-1.png");
    expect(result.size_bytes).toBe(99);
  });

  // FA-3: 413 throws Error with .status = 413.
  it("FA-3: 413 from server → throws Error with .status = 413", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("file too large", { status: 413 }),
    );
    const file = new File(["x"], "huge.bin");
    await expect(uploadFile("", file)).rejects.toMatchObject({
      status: 413,
    });
  });

  // FA-3b: 400 (e.g. .md upload refused) likewise carries .status.
  it("FA-3b: 400 from server → throws Error with .status = 400", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("invalid_filename", { status: 400 }),
    );
    const file = new File(["x"], "note.md");
    await expect(uploadFile("", file)).rejects.toMatchObject({
      status: 400,
    });
  });

  // FA-3c: 403 (symlink rejected) carries .status.
  it("FA-3c: 403 from server → throws Error with .status = 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("symlink_rejected", { status: 403 }),
    );
    const file = new File(["x"], "x.png");
    await expect(uploadFile("link-target", file)).rejects.toMatchObject({
      status: 403,
    });
  });
});
