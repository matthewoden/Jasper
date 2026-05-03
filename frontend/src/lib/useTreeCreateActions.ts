/**
 * useTreeCreateActions — shared create-note / create-folder handlers.
 *
 * Both Sidebar's toolbar (root-level create) and FileTree's context-menu
 * + kebab callbacks (per-row create at a specific parent) call this
 * hook so the create flow is identical regardless of trigger.
 *
 * Behavior:
 *   1. POST /notes (or /folders) with parentPath + a "untitled" name.
 *   2. Refresh the tree.
 *   3. Set useTreeStore.pendingRename to the new node so it immediately
 *      enters inline-rename mode with the locked default name selected.
 *   4. On TreeMutationError or any other failure, surface a destructive
 *      toast with the matching locked tuple per UI-SPEC §Surface 5.
 */
import { useCallback } from "react";

import {
  TreeMutationError,
  useTreeMutations,
} from "./useTreeMutations";
import { useFileTree } from "./useFileTree";
import { useTreeStore } from "./useTreeStore";
import { useToast } from "../components/Toast";

export interface UseTreeCreateActions {
  createNoteAt: (parentPath: string) => Promise<void>;
  createFolderAt: (parentPath: string) => Promise<void>;
}

export function useTreeCreateActions(): UseTreeCreateActions {
  const muts = useTreeMutations();
  const { refresh } = useFileTree();
  const { toast } = useToast();

  const handleErr = useCallback(
    (e: unknown) => {
      if (e instanceof TreeMutationError && e.code === "case_collision") {
        toast({
          title: "That name already exists.",
          description: `${e.message} Try a different name.`,
          variant: "error",
        });
        return;
      }
      if (
        e instanceof TreeMutationError &&
        e.code === "invalid_request"
      ) {
        toast({
          title: "That name has characters that aren't allowed.",
          description:
            "Use letters, numbers, dashes, and underscores in note and folder names.",
          variant: "error",
        });
        return;
      }
      toast({
        title: "Something went wrong on the server.",
        description:
          e instanceof Error ? e.message : "Try again or check the logs.",
        variant: "error",
      });
    },
    [toast],
  );

  const createNoteAt = useCallback(
    async (parentPath: string) => {
      try {
        const s = await muts.createNote(parentPath, "untitled");
        await refresh();
        useTreeStore.getState().startRename("note", s.id);
      } catch (e) {
        handleErr(e);
      }
    },
    [muts, refresh, handleErr],
  );

  const createFolderAt = useCallback(
    async (parentPath: string) => {
      try {
        const f = await muts.createFolder(parentPath, "untitled");
        await refresh();
        useTreeStore.getState().startRename("folder", f.path);
      } catch (e) {
        handleErr(e);
      }
    },
    [muts, refresh, handleErr],
  );

  return { createNoteAt, createFolderAt };
}
