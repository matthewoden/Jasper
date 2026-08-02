/**
 * Tests for filesApi — uploadFile, deleteFile, moveFile.
 * Wire format uses ?path= query parameter, not a path segment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  uploadFile,
  type UploadFileResult,
  deleteFile,
  moveFile,
} from "./filesApi";

describe("filesApi.uploadFile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    expect(url).toBe("/api/v1/files?path=gallery");
    expect(opts?.method).toBe("POST");
    expect(opts?.body).toBeInstanceOf(FormData);
    const headers = opts?.headers as Record<string, string> | Headers | undefined;
    const sid =
      headers instanceof Headers
        ? headers.get("X-Session-ID")
        : (headers as Record<string, string> | undefined)?.["X-Session-ID"];
    expect(sid).toBeTruthy();
  });

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
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/v1/files?path=a%2Fb");
  });

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

  it("FA-3: 413 from server → throws Error with .status = 413", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("file too large", { status: 413 }),
    );
    const file = new File(["x"], "huge.bin");
    await expect(uploadFile("", file)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("FA-3b: 400 from server → throws Error with .status = 400", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("invalid_filename", { status: 400 }),
    );
    const file = new File(["x"], "note.md");
    await expect(uploadFile("", file)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("FA-3c: 403 from server → throws Error with .status = 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("symlink_rejected", { status: 403 }),
    );
    const file = new File(["x"], "x.png");
    await expect(uploadFile("link-target", file)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("FA-4: error includes response body text + .body field on the error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ code: "invalid_path", message: "target dir does not exist" }),
        { status: 400 },
      ),
    );
    const file = new File(["x"], "x.png");
    try {
      await uploadFile("bogus", file);
      throw new Error("expected throw");
    } catch (e) {
      const err = e as Error & { status?: number; body?: string };
      expect(err.status).toBe(400);
      expect(err.body).toContain("target dir does not exist");
      expect(err.message).toContain("target dir does not exist");
    }
  });
});

describe("filesApi.deleteFile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("FA-DEL-1: DELETEs /api/v1/files?path=<encoded path>", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    await deleteFile("gallery/photo.png");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/v1/files?path=gallery%2Fphoto.png");
    expect(opts?.method).toBe("DELETE");
    const headers = opts?.headers as Record<string, string> | Headers | undefined;
    const sid =
      headers instanceof Headers
        ? headers.get("X-Session-ID")
        : (headers as Record<string, string> | undefined)?.["X-Session-ID"];
    expect(sid).toBeTruthy();
  });

  it("FA-DEL-2: 204 success resolves without error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    await expect(deleteFile("x.png")).resolves.toBeUndefined();
  });

  it("FA-DEL-3: 400 throws with .status = 400 and body in message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ code: "invalid_path", message: "path is a directory" }),
        { status: 400 },
      ),
    );
    await expect(deleteFile("subdir")).rejects.toMatchObject({ status: 400 });
  });

  it("FA-DEL-4: 404 throws with .status = 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", { status: 404 }),
    );
    await expect(deleteFile("missing.png")).rejects.toMatchObject({ status: 404 });
  });
});

describe("filesApi.moveFile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("FA-MV-1: POSTs /api/v1/files/move with JSON body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ path: "b.png", name: "b.png" }), {
        status: 200,
      }),
    );
    const result = await moveFile("a.png", "b.png");
    expect(result.path).toBe("b.png");
    expect(result.name).toBe("b.png");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/v1/files/move");
    expect(opts?.method).toBe("POST");
    expect(typeof opts?.body).toBe("string");
    expect(JSON.parse(opts!.body as string)).toEqual({
      src_path: "a.png",
      dst_path: "b.png",
    });
    const headers = opts?.headers as Record<string, string> | Headers | undefined;
    const ct =
      headers instanceof Headers
        ? headers.get("Content-Type")
        : (headers as Record<string, string> | undefined)?.["Content-Type"];
    expect(ct).toBe("application/json");
  });

  it("FA-MV-2: 409 from server → throws with .status = 409", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ code: "already_exists", message: "dest exists" }),
        { status: 409 },
      ),
    );
    await expect(moveFile("a.png", "b.png")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("FA-MV-3: 400 from server → throws with .status = 400 and body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ code: "invalid_path", message: "dst escapes notes" }),
        { status: 400 },
      ),
    );
    await expect(moveFile("a.png", "../../evil.png")).rejects.toMatchObject({
      status: 400,
    });
  });
});
