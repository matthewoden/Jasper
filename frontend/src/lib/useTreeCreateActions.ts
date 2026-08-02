/**
 * useTreeCreateActions — the shared create-note / create-folder flow, so the
 * toolbar and the per-row menus behave identically.
 *
 * The name is computed from the target's existing siblings, so clicking + twice
 * yields "untitled" then "untitled 1" rather than a 409.
 *
 * The new node enters inline rename with isNew=true, which makes Escape or a
 * same-name blur DELETE it rather than leave an auto-generated name on disk.
 */
import { useCallback, useState } from "react";

import { nextUntitledName } from "./nextUntitledName";
import type { FolderNode, Tree, TreeNode } from "./treeApi";
import { useFileTree } from "./useFileTree";
import {
  TreeMutationError,
  useTreeMutations,
} from "./useTreeMutations";
import { useTreeStore } from "./useTreeStore";
import { useToast } from "../components/toast.utils";

export interface UseTreeCreateActions {
  createNoteAt: (parentPath: string) => Promise<void>;
  createFolderAt: (parentPath: string) => Promise<void>;
  /**
   * True while a create is in flight. Drives toolbar disabled-state visuals
   * and the hook's own early-return so a second same-tick click is a no-op.
   * Cleared in finally so retry after failure is always available.
   */
  isCreating: boolean;
}

/**
 * findFolderByPath — recursively returns the folder whose path matches parentPath exactly,
 * or null if not found (caller treats as "no siblings"; server handles a genuinely missing parent).
 */
function findFolderByPath(
  nodes: readonly TreeNode[],
  path: string,
): FolderNode | null {
  for (const n of nodes) {
    if (n.kind !== "folder") continue;
    if (n.path === path) return n;
    if (n.children) {
      const found = findFolderByPath(n.children, path);
      if (found) return found;
    }
  }
  return null;
}

/**
 * siblingNamesForCreate — returns existing sibling names at the target parent,
 * filtered to the given kind (note → titles without .md; folder → folder names).
 * Kind-scoped because notes (*.md) and folders can share a base name without collision.
 * Exported for testability.
 */
export function siblingNamesForCreate(
  tree: Tree | null,
  parentPath: string,
  kind: "note" | "folder",
): string[] {
  if (!tree) return [];
  let nodes: readonly TreeNode[];
  if (parentPath === "") {
    nodes = tree.root;
  } else {
    const folder = findFolderByPath(tree.root, parentPath);
    if (!folder) return [];
    nodes = folder.children ?? [];
  }
  const out: string[] = [];
  for (const n of nodes) {
    if (kind === "note" && n.kind === "note") {
      out.push(n.title.endsWith(".md") ? n.title.slice(0, -3) : n.title);
    } else if (kind === "folder" && n.kind === "folder") {
      out.push(n.name);
    }
  }
  return out;
}

export function useTreeCreateActions(): UseTreeCreateActions {
  const muts = useTreeMutations();
  const { tree } = useFileTree();
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);

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
      if (isCreating) return;
      setIsCreating(true);
      try {
        const siblings = siblingNamesForCreate(tree, parentPath, "note");
        const title = nextUntitledName(siblings, "untitled");
        const s = await muts.createNote(parentPath, title);
        useTreeStore.getState().startRename("note", s.id, true);
      } catch (e) {
        handleErr(e);
      } finally {
        setIsCreating(false);
      }
    },
    [muts, tree, handleErr, isCreating],
  );

  const createFolderAt = useCallback(
    async (parentPath: string) => {
      if (isCreating) return;
      setIsCreating(true);
      try {
        const siblings = siblingNamesForCreate(tree, parentPath, "folder");
        const name = nextUntitledName(siblings, "untitled");
        const f = await muts.createFolder(parentPath, name);
        useTreeStore.getState().startRename("folder", f.path, true);
      } catch (e) {
        handleErr(e);
      } finally {
        setIsCreating(false);
      }
    },
    [muts, tree, handleErr, isCreating],
  );

  return { createNoteAt, createFolderAt, isCreating };
}
