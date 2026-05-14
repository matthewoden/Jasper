/**
 * useAttachmentUpload.ts — Phase 7 Plan 10 / ATTACH-01..ATTACH-02.
 *
 * Provides drag-over/drop and clipboard-paste handlers that upload files to
 * the backend and insert the resulting markdown reference into the active
 * CodeMirror editor view.
 *
 * Counter pattern (Pitfall 4): nested dragenter/dragleave on child elements
 * fire extra events on the parent. Tracking depth with a ref ensures the
 * drop-active state only clears when the drag truly leaves the root container.
 *
 * Paste (D-28): only intercepts clipboard items with an image/* MIME type.
 * Text-paste falls through to CodeMirror's default handler.
 *
 * Filename convention for paste (D-28):
 *   paste-YYYY-MM-DDTHH-MM-SS.{ext}
 * (ISO date with colons replaced by hyphens for filesystem safety.)
 *
 * Toast copy (UI-SPEC §Copywriting Contract §Attachments, LOCKED):
 *   413 → title: "File too large", description: "The maximum upload size is 100 MB. Use an external link instead."
 *   other → title: "Couldn't attach file", description: "Try again, or use Show in file manager to add it manually."
 */
import { useCallback, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { uploadAttachment, AttachmentTooLargeError } from "./attachmentApi";
import { useToast } from "../components/Toast";

export interface UseAttachmentUploadResult {
  /** True when a file drag is over the editor surface (depth > 0). */
  isDropTargetActive: boolean;
  dragHandlers: {
    onDragEnter: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent, view: EditorView) => Promise<void>;
  };
  pasteHandler: (e: ClipboardEvent, view: EditorView) => Promise<void>;
}

/**
 * useAttachmentUpload — returns drag and paste handlers for a CodeMirror
 * editor wrapper. The noteId determines the upload route target; pass null
 * when no note is active (upload is blocked with an error toast).
 */
export function useAttachmentUpload(
  noteId: string | null
): UseAttachmentUploadResult {
  const { toast } = useToast();
  const dragDepthRef = useRef(0);
  const [isDropTargetActive, setIsDropTargetActive] = useState(false);

  // ---- internal helpers ------------------------------------------------

  const insertMarkdown = useCallback(
    (view: EditorView, markdown: string, pos: number) => {
      view.dispatch({
        changes: { from: pos, to: pos, insert: markdown },
      });
    },
    []
  );

  const uploadAndInsert = useCallback(
    async (file: File, view: EditorView, pos: number): Promise<void> => {
      if (!noteId) {
        toast({
          title: "Couldn't attach file",
          description: "No active note.",
          variant: "error",
        });
        return;
      }

      try {
        const res = await uploadAttachment(noteId, file);
        const refMd = res.is_image
          ? `![${res.filename}](${res.path})`
          : `[${res.filename}](${res.path})`;
        insertMarkdown(view, refMd, pos);
      } catch (e) {
        if (e instanceof AttachmentTooLargeError) {
          toast({
            title: "File too large",
            description:
              "The maximum upload size is 100 MB. Use an external link instead.",
            variant: "error",
          });
        } else {
          toast({
            title: "Couldn't attach file",
            description:
              "Try again, or use Show in file manager to add it manually.",
            variant: "error",
          });
        }
      }
    },
    [noteId, insertMarkdown, toast]
  );

  // ---- drag handlers ---------------------------------------------------

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!e.dataTransfer || e.dataTransfer.types.indexOf("Files") < 0) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    if (dragDepthRef.current === 1) {
      setIsDropTargetActive(true);
    }
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer && e.dataTransfer.types.indexOf("Files") >= 0) {
      e.preventDefault();
    }
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onDragLeave = useCallback((_dragEvent: DragEvent) => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDropTargetActive(false);
    }
  }, []);

  const onDrop = useCallback(
    async (e: DragEvent, view: EditorView): Promise<void> => {
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsDropTargetActive(false);

      const files = Array.from(e.dataTransfer?.files ?? []);
      const dropPos =
        view.posAtCoords({ x: e.clientX, y: e.clientY }) ??
        view.state.selection.main.head;

      for (const file of files) {
        // Sequential upload — preserves drop order; each insert happens
        // after its upload resolves (D-28 / UI-SPEC §Surface 7).
        await uploadAndInsert(file, view, dropPos);
      }
    },
    [uploadAndInsert]
  );

  // ---- paste handler (images only, D-28) --------------------------------

  const pasteHandler = useCallback(
    async (e: ClipboardEvent, view: EditorView): Promise<void> => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find(
        (i) => i.kind === "file" && i.type.startsWith("image/")
      );
      if (!imageItem) return; // fall through to CodeMirror default text paste

      e.preventDefault();
      const blob = imageItem.getAsFile();
      if (!blob) return;

      // Filename: paste-YYYY-MM-DDTHH-MM-SS.{ext} (D-28 filesystem safety)
      const ext = imageItem.type.split("/")[1] ?? "png";
      const ts = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const file = new File([blob], `paste-${ts}.${ext}`, {
        type: imageItem.type,
      });

      await uploadAndInsert(file, view, view.state.selection.main.head);
    },
    [uploadAndInsert]
  );

  return {
    isDropTargetActive,
    dragHandlers: { onDragEnter, onDragLeave, onDragOver, onDrop },
    pasteHandler,
  };
}
