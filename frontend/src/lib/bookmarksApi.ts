/**
 * Typed wrappers over /bookmarks*. Every one THROWS on non-2xx, including
 * getBookmarks — it used to swallow errors, which silently rendered the empty
 * state on a failed fetch.
 */

import { client } from "../api/client";
import { createResource } from "./resources";
import type { Bookmark, BookmarkFolder } from "./useTreeStore";

export interface BookmarksDocument {
  folders: BookmarkFolder[];
  bookmarks: Bookmark[];
}

function unwrapErrorMessage(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

async function getBookmarks(): Promise<BookmarksDocument> {
  const { data, error } = await client.GET("/bookmarks");
  if (error || !data) {
    throw new Error(unwrapErrorMessage(error, "could not load bookmarks"));
  }
  return data as BookmarksDocument;
}

export const bookmarksResource = createResource("bookmarks", getBookmarks, {
  mode: "cached",
  invalidatedBy: ["bookmark:changed"],
});

export async function postBookmark(
  noteId: string,
  folderId?: string | null,
): Promise<Bookmark> {
  const { data, error } = await client.POST("/bookmarks", {
    body: { note_id: noteId, folder_id: folderId ?? undefined },
  });
  if (error || !data) {
    throw new Error(unwrapErrorMessage(error, "bookmark failed"));
  }
  return data as Bookmark;
}

export async function deleteBookmark(id: string): Promise<void> {
  const { error } = await client.DELETE("/bookmarks/{id}", {
    params: { path: { id } },
  });
  if (error) {
    throw new Error(unwrapErrorMessage(error, "remove bookmark failed"));
  }
}

export async function postBookmarkMove(
  id: string,
  folderId: string | null,
): Promise<{ id: string; folder_id: string | null }> {
  const { data, error } = await client.POST("/bookmarks/{id}/folder", {
    params: { path: { id } },
    body: { folder_id: folderId },
  });
  if (error || !data) {
    throw new Error(unwrapErrorMessage(error, "move bookmark failed"));
  }
  return data;
}

export async function postBookmarkFolder(
  name: string,
): Promise<BookmarkFolder> {
  const { data, error } = await client.POST("/bookmark-folders", {
    body: { name },
  });
  if (error || !data) {
    throw new Error(unwrapErrorMessage(error, "create folder failed"));
  }
  return data as BookmarkFolder;
}

/**
 * Sets the explicit display order for EVERY bookmark in one folder scope
 * (folderId null = top-level). orderedIds must be exactly the current
 * membership of that scope — the backend rejects a mismatch with 404
 * and an unknown folderId with 400.
 */
export async function reorderBookmarks(
  folderId: string | null,
  orderedIds: string[],
): Promise<void> {
  const { error } = await client.POST("/bookmarks/reorder", {
    body: { folder_id: folderId, ordered_ids: orderedIds },
  });
  if (error) {
    throw new Error(unwrapErrorMessage(error, "reorder bookmarks failed"));
  }
}
