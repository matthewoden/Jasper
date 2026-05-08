/**
 * useTreeCreateActions — shared create-note / create-folder handlers.
 *
 * Both Sidebar's toolbar (root-level create) and FileTree's context-menu
 * + kebab callbacks (per-row create at a specific parent) call this
 * hook so the create flow is identical regardless of trigger.
 *
 * Behavior:
 *   1. Read the current tree state via useFileTree(), find the target
 *      parent's children, and compute the lowest non-colliding default
 *      name via nextUntitledName(siblings, "untitled"). This closes
 *      Gap 5 (Finding A.2 in 03-HUMAN-UAT.md) — clicking `+` twice in
 *      the same folder now produces `untitled.md` then `untitled 1.md`
 *      instead of throwing a 409 case_collision the second time.
 *   2. POST /notes (or /folders) with parentPath + the auto-incremented
 *      name. The mutator inside useTreeMutations refreshes the tree on
 *      success automatically (Plan 03-09 — Gap 1 contract is in the
 *      data layer, not the caller). The next create reads fresh
 *      sibling names from the post-refresh tree.
 *   3. Set useTreeStore.pendingRename to the new node so it
 *      immediately enters inline-rename mode with the locked default
 *      name selected. This runs AFTER muts.createNote / muts.createFolder
 *      resolves — by then the auto-refresh has landed and the new row
 *      exists in the freshly-fetched tree.
 *      Bug D fix: startRename is called with isNew=true so that if the
 *      user presses Escape (or blurs without changing the placeholder
 *      name), TreeRow's cancel handler deletes the ephemeral node
 *      instead of leaving the auto-generated "untitled" file on disk.
 *   4. On TreeMutationError or any other failure, surface a destructive
 *      toast with the matching locked tuple per UI-SPEC §Surface 5. The
 *      auto-increment runs entirely client-side BEFORE the POST, so
 *      `case_collision` toasts now only fire for genuine race-condition
 *      collisions (e.g., another process created an identically-named
 *      file between the tree fetch and the POST).
 *   5. In-flight guard (Gap R2-2): a single `isCreating` boolean is
 *      surfaced on the hook return. While true, both `createNoteAt` and
 *      `createFolderAt` early-return, and the toolbar in Sidebar visibly
 *      disables the New Note + New Folder buttons (mirroring the existing
 *      Refresh-button spin-disabled pattern in `SidebarToolbar.tsx`). This
 *      closes the rapid-double-click race where the second click read the
 *      pre-create snapshot of `tree`, recomputed `"untitled"`, and 409'd.
 *      The guard is per-flight (not permanent): it clears in the `finally`
 *      block so the user can retry immediately on either success or
 *      failure. The early-return is also defense-in-depth for the
 *      per-row create paths (FileTree's context-menu / kebab "New note"
 *      and "New folder") which don't currently expose their own
 *      disable-while-creating affordance.
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
import { useToast } from "../components/Toast";

export interface UseTreeCreateActions {
  createNoteAt: (parentPath: string) => Promise<void>;
  createFolderAt: (parentPath: string) => Promise<void>;
  /**
   * Gap R2-2 — true while a create is in flight. Drives:
   *   - SidebarToolbar's New Note + New Folder disabled-state visuals
   *     (mirrors the existing Refresh-button spin-disabled pattern).
   *   - The hook's own internal early-return so a second click during
   *     a same-tick race is a no-op rather than a 409.
   * Cleared in the create handlers' `finally` block, so a retry after a
   * failure is always available immediately.
   */
  isCreating: boolean;
}

/**
 * findFolderByPath — recursively walk the tree's nodes and return the
 * folder whose canonical `path` matches the given parentPath exactly.
 * Returns null if no such folder exists (caller treats as "no siblings"
 * — the server will produce the authoritative error if the parent is
 * actually missing).
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
 * siblingNamesForCreate — returns the existing sibling names at the
 * target parent for the given kind (note → titles minus `.md`; folder
 * → folder names). The list passed to nextUntitledName is intentionally
 * filtered to ONLY the kind being created — a sibling note named
 * "untitled" does not block a sibling folder named "untitled" (the
 * server's collision check is also kind-scoped within a parent
 * directory because notes are `*.md` files and folders are not).
 *
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
      // The schema says NoteNode.title is "filename without `.md`",
      // but strip defensively to survive any drift.
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
  // Gap R2-2 — in-flight guard. A single boolean covers BOTH create
  // actions so a rapid New Note → New Folder combo (or vice versa) is
  // also serialized.
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
      // Gap R2-2: while a create is in flight, ignore additional clicks.
      // The button is also visibly disabled in SidebarToolbar so this is
      // defense-in-depth; the early-return covers per-row create paths
      // (FileTree's context-menu / kebab "New note") which don't have
      // their own disable-while-creating affordance yet.
      if (isCreating) return;
      setIsCreating(true);
      try {
        const siblings = siblingNamesForCreate(tree, parentPath, "note");
        const title = nextUntitledName(siblings, "untitled");
        const s = await muts.createNote(parentPath, title);
        // Bug D fix: pass isNew=true so that Escape / same-name-blur
        // deletes this ephemeral node instead of leaving "untitled" on disk.
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
      // Gap R2-2: same in-flight guard semantics as createNoteAt — a New
      // Folder click while New Note is in flight (or vice versa) is also
      // short-circuited.
      if (isCreating) return;
      setIsCreating(true);
      try {
        const siblings = siblingNamesForCreate(tree, parentPath, "folder");
        const name = nextUntitledName(siblings, "untitled");
        const f = await muts.createFolder(parentPath, name);
        // Bug D fix: pass isNew=true so that Escape / same-name-blur
        // deletes this ephemeral node instead of leaving "untitled" on disk.
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
