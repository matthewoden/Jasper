/**
 * bookmarksApi — typed wrappers over the /bookmarks* endpoints.
 * All calls route through the openapi-fetch client; no hand-written request shapes.
 *
 * Endpoints:
 *   GET    /api/v1/bookmarks             → getBookmarks(): BookmarksDocument
 *   POST   /api/v1/bookmarks             → postBookmark(noteId, folderId?): Bookmark
 *   DELETE /api/v1/bookmarks/{id}        → deleteBookmark(id): void
 *   POST   /api/v1/bookmarks/{id}/folder → postBookmarkMove(id, folderId): {id, folder_id}
 *   POST   /api/v1/bookmark-folders      → postBookmarkFolder(name): BookmarkFolder
 *
 * Each wrapper throws on non-2xx so callers can use try/catch, except
 * getBookmarks() which returns an empty document on error — mirrors
 * listGrants()'s never-throws-to-refresh()-caller contract so a transient
 * backend hiccup doesn't wipe previously-cached bookmarks from the store.
 */

import { client } from "../api/client";
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

export async function getBookmarks(): Promise<BookmarksDocument> {
  const { data, error } = await client.GET("/bookmarks");
  if (error || !data) return { folders: [], bookmarks: [] };
  return data as BookmarksDocument;
}

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
