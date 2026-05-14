/**
 * useAttachmentUpload.test.ts — Phase 7 Plan 10 / ATTACH-01..ATTACH-02
 *
 * Tests cover:
 *   - Drag counter pattern: nested dragenter/dragleave correctly tracked
 *   - pasteHandler: only handles image MIME items
 *   - uploadAndInsert: inserts markdown at specified position
 *   - Toast for 413 (File too large) with locked copy
 *   - Toast for generic errors (Couldn't attach file)
 *   - Image upload inserts ![filename](attachments/...) markdown
 *   - Non-image upload inserts [filename](attachments/...) markdown
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAttachmentUpload } from "./useAttachmentUpload";
import * as attachmentApiModule from "./attachmentApi";
import { AttachmentTooLargeError } from "./attachmentApi";
import type { AttachmentUploadResult } from "./attachmentApi";

// Mock useToast
const mockToastFn = vi.fn();
vi.mock("../components/Toast", () => ({
  useToast: () => ({
    toast: mockToastFn,
  }),
}));

// Helper to create a minimal fake EditorView
function makeFakeView(insertedAt: { pos: number; text: string }) {
  const state = {
    selection: {
      main: { head: 5 },
    },
    doc: { length: 100 },
  };
  const view = {
    state,
    dispatch: vi.fn((tr: { changes: { from: number; to: number; insert: string } }) => {
      insertedAt.pos = tr.changes.from;
      insertedAt.text = tr.changes.insert;
    }),
    posAtCoords: vi.fn(() => null),
  };
  return view as unknown as import("@codemirror/view").EditorView;
}

describe("useAttachmentUpload / drag counter pattern", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dragDepth increments on dragenter (with files) and decrements on dragleave", async () => {
    const { result } = renderHook(() =>
      useAttachmentUpload("test-note-id")
    );

    const makeEvent = () => ({
      preventDefault: vi.fn(),
      dataTransfer: { types: ["Files"] },
      clientX: 0,
      clientY: 0,
    } as unknown as DragEvent);

    // Initial: not active
    expect(result.current.isDropTargetActive).toBe(false);

    // First enter → depth becomes 1, active
    act(() => { result.current.dragHandlers.onDragEnter(makeEvent()); });
    expect(result.current.isDropTargetActive).toBe(true);

    // Second enter (child element) → depth becomes 2, still active
    act(() => { result.current.dragHandlers.onDragEnter(makeEvent()); });
    expect(result.current.isDropTargetActive).toBe(true);

    // First leave → depth back to 1, still active
    act(() => { result.current.dragHandlers.onDragLeave(makeEvent()); });
    expect(result.current.isDropTargetActive).toBe(true);

    // Second leave → depth back to 0, no longer active
    act(() => { result.current.dragHandlers.onDragLeave(makeEvent()); });
    expect(result.current.isDropTargetActive).toBe(false);
  });

  it("dragenter with no Files in types does not set active", () => {
    const { result } = renderHook(() =>
      useAttachmentUpload("test-note-id")
    );

    const e = {
      preventDefault: vi.fn(),
      dataTransfer: { types: ["text/plain"] },
    } as unknown as DragEvent;

    act(() => { result.current.dragHandlers.onDragEnter(e); });
    expect(result.current.isDropTargetActive).toBe(false);
  });

  it("drop resets depth to 0 and deactivates drop target", async () => {
    const { result } = renderHook(() =>
      useAttachmentUpload("test-note-id")
    );

    vi.spyOn(attachmentApiModule, "uploadAttachment").mockResolvedValue({
      filename: "x.png",
      path: "attachments/x.png",
      content_type: "image/png",
      category: "image",
      is_image: true,
      size_bytes: 100,
    });

    const enterEvent = {
      preventDefault: vi.fn(),
      dataTransfer: { types: ["Files"] },
    } as unknown as DragEvent;

    // Enter twice
    act(() => { result.current.dragHandlers.onDragEnter(enterEvent); });
    act(() => { result.current.dragHandlers.onDragEnter(enterEvent); });
    expect(result.current.isDropTargetActive).toBe(true);

    const insertedAt = { pos: -1, text: "" };
    const view = makeFakeView(insertedAt);

    const dropEvent = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(["x"], "x.png", { type: "image/png" })] },
      clientX: 10,
      clientY: 10,
    } as unknown as DragEvent;

    await act(async () => {
      await result.current.dragHandlers.onDrop(dropEvent, view);
    });

    // After drop, depth should be 0 (inactive)
    expect(result.current.isDropTargetActive).toBe(false);
  });
});

describe("useAttachmentUpload / pasteHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pasteHandler ignores non-image clipboard items", async () => {
    const { result } = renderHook(() =>
      useAttachmentUpload("test-note-id")
    );
    const uploadSpy = vi
      .spyOn(attachmentApiModule, "uploadAttachment")
      .mockResolvedValue({} as AttachmentUploadResult);

    const insertedAt = { pos: -1, text: "" };
    const view = makeFakeView(insertedAt);

    const e = {
      preventDefault: vi.fn(),
      clipboardData: {
        items: [
          { kind: "file", type: "application/pdf", getAsFile: () => null },
        ],
      },
    } as unknown as ClipboardEvent;

    await act(async () => {
      await result.current.pasteHandler(e, view);
    });

    // Non-image: should NOT call uploadAttachment
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("pasteHandler handles image clipboard items and generates paste- filename", async () => {
    const { result } = renderHook(() =>
      useAttachmentUpload("test-note-id")
    );

    const mockResult: AttachmentUploadResult = {
      filename: "paste-2026-05-13T12-00-00.png",
      path: "attachments/paste-2026-05-13T12-00-00.png",
      content_type: "image/png",
      category: "image",
      is_image: true,
      size_bytes: 100,
    };
    vi.spyOn(attachmentApiModule, "uploadAttachment").mockResolvedValue(
      mockResult
    );

    const insertedAt = { pos: -1, text: "" };
    const view = makeFakeView(insertedAt);

    const mockBlob = new Blob(["x"], { type: "image/png" });
    const imageItem = {
      kind: "file",
      type: "image/png",
      getAsFile: () => mockBlob,
    };

    const e = {
      preventDefault: vi.fn(),
      clipboardData: {
        items: [imageItem],
      },
    } as unknown as ClipboardEvent;

    await act(async () => {
      await result.current.pasteHandler(e, view);
    });

    // Must call preventDefault (intercept clipboard default)
    expect(e.preventDefault).toHaveBeenCalled();

    // Must upload the file
    expect(attachmentApiModule.uploadAttachment).toHaveBeenCalledOnce();

    // Uploaded file must have paste- prefix
    const uploadedFile = vi.mocked(attachmentApiModule.uploadAttachment).mock
      .calls[0][1] as File;
    expect(uploadedFile.name).toMatch(/^paste-\d{4}-\d{2}-\d{2}T/);
    expect(uploadedFile.type).toBe("image/png");

    // Markdown for image should be inserted
    expect(insertedAt.text).toMatch(/^!\[/);
    expect(insertedAt.text).toContain("attachments/");
  });

  it("pasteHandler ignores non-file clipboard items (text)", async () => {
    const { result } = renderHook(() =>
      useAttachmentUpload("test-note-id")
    );
    const uploadSpy = vi
      .spyOn(attachmentApiModule, "uploadAttachment")
      .mockResolvedValue({} as AttachmentUploadResult);

    const insertedAt = { pos: -1, text: "" };
    const view = makeFakeView(insertedAt);

    const e = {
      preventDefault: vi.fn(),
      clipboardData: {
        items: [
          { kind: "string", type: "text/plain" },
        ],
      },
    } as unknown as ClipboardEvent;

    await act(async () => {
      await result.current.pasteHandler(e, view);
    });

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe("useAttachmentUpload / uploadAndInsert via drop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("413 error shows 'File too large' toast with locked copy", async () => {
    vi.spyOn(attachmentApiModule, "uploadAttachment").mockRejectedValue(
      new AttachmentTooLargeError()
    );

    const { result } = renderHook(() =>
      useAttachmentUpload("test-note-id")
    );

    const insertedAt = { pos: -1, text: "" };
    const view = makeFakeView(insertedAt);

    const e = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(["x"], "big.png")] },
      clientX: 10,
      clientY: 10,
    } as unknown as DragEvent;

    await act(async () => {
      await result.current.dragHandlers.onDrop(e, view);
    });

    expect(mockToastFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "File too large",
        description: expect.stringContaining("100 MB"),
      })
    );
  });

  it("generic error shows 'Couldn't attach file' toast", async () => {
    vi.spyOn(attachmentApiModule, "uploadAttachment").mockRejectedValue(
      new Error("network error")
    );

    const { result } = renderHook(() =>
      useAttachmentUpload("test-note-id")
    );

    const insertedAt = { pos: -1, text: "" };
    const view = makeFakeView(insertedAt);

    const e = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(["x"], "file.txt")] },
      clientX: 10,
      clientY: 10,
    } as unknown as DragEvent;

    await act(async () => {
      await result.current.dragHandlers.onDrop(e, view);
    });

    expect(mockToastFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't attach file",
      })
    );
  });

  it("image upload inserts ![filename](attachments/...) markdown", async () => {
    const mockResult: AttachmentUploadResult = {
      filename: "photo.png",
      path: "attachments/photo.png",
      content_type: "image/png",
      category: "image",
      is_image: true,
      size_bytes: 1000,
    };
    vi.spyOn(attachmentApiModule, "uploadAttachment").mockResolvedValue(
      mockResult
    );

    const { result } = renderHook(() =>
      useAttachmentUpload("test-note-id")
    );

    const insertedAt = { pos: -1, text: "" };
    const view = makeFakeView(insertedAt);

    const e = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(["x"], "photo.png", { type: "image/png" })] },
      clientX: 10,
      clientY: 10,
    } as unknown as DragEvent;

    await act(async () => {
      await result.current.dragHandlers.onDrop(e, view);
    });

    expect(insertedAt.text).toBe("![photo.png](attachments/photo.png)");
  });

  it("non-image upload inserts [filename](attachments/...) markdown", async () => {
    const mockResult: AttachmentUploadResult = {
      filename: "report.pdf",
      path: "attachments/report.pdf",
      content_type: "application/pdf",
      category: "pdf",
      is_image: false,
      size_bytes: 55000,
    };
    vi.spyOn(attachmentApiModule, "uploadAttachment").mockResolvedValue(
      mockResult
    );

    const { result } = renderHook(() =>
      useAttachmentUpload("test-note-id")
    );

    const insertedAt = { pos: -1, text: "" };
    const view = makeFakeView(insertedAt);

    const e = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(["x"], "report.pdf", { type: "application/pdf" })] },
      clientX: 10,
      clientY: 10,
    } as unknown as DragEvent;

    await act(async () => {
      await result.current.dragHandlers.onDrop(e, view);
    });

    expect(insertedAt.text).toBe("[report.pdf](attachments/report.pdf)");
  });

  it("null noteId shows error toast instead of uploading", async () => {
    const uploadSpy = vi.spyOn(attachmentApiModule, "uploadAttachment");

    const { result } = renderHook(() =>
      useAttachmentUpload(null)
    );

    const insertedAt = { pos: -1, text: "" };
    const view = makeFakeView(insertedAt);

    const e = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(["x"], "file.png")] },
      clientX: 10,
      clientY: 10,
    } as unknown as DragEvent;

    await act(async () => {
      await result.current.dragHandlers.onDrop(e, view);
    });

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(mockToastFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't attach file",
      })
    );
  });
});
