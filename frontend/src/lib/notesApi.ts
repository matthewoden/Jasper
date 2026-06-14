/**
 * The single network surface for note operations. All calls route through the
 * typed openapi-fetch client; components import these wrappers, not `client`
 * directly, so tests only need to mock this module.
 *
 * The path key `"/notes/{id}"` is the typed OpenAPI key, not a URL string.
 * openapi-fetch composes the actual URL as /api/v1/notes/{id} from the
 * client's baseUrl and the spec's servers prefix.
 */

import { client } from "../api/client";

/**
 * Hard-coded UUID for the scratchpad note. Must match the backend's
 * notes.ScratchpadUUID constant byte-for-byte.
 */
export const ScratchpadUUID =
  "00000000-0000-4000-a000-000000000001" as const;

export function getNote(id: string, options?: { signal?: AbortSignal }) {
  return client.GET("/notes/{id}", {
    params: { path: { id } },
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

export function updateNote(id: string, content: string, ifMatch?: string) {
  return client.PUT("/notes/{id}", {
    params: { path: { id } },
    body: { content },
    ...(ifMatch ? { headers: { "If-Match": ifMatch } } : {}),
  });
}

/** Shape returned by GET /api/v1/notes/search-titles. */
export interface NoteSearchResult {
  id: string;
  title: string;
  folder?: string | null;
  recency_score: number;
  proximity_score?: number | null;
}

/**
 * Search note titles for wiki-link autocomplete.
 * Empty q returns most-recently-edited notes up to limit.
 * Server ranks by recency (60%) + proximity (40%).
 * Throws on HTTP error so the caller can catch and degrade gracefully.
 */
export async function searchTitles(
  q: string,
  limit = 10,
): Promise<NoteSearchResult[]> {
  const { data, error } = await client.GET("/notes/search-titles", {
    params: { query: { q, limit } },
  });
  if (error) {
    throw new Error("searchTitles: " + JSON.stringify(error));
  }
  return data.results as NoteSearchResult[];
}

/**
 * createNoteFromMarkdownDrop — creates a note from a .md file dropped into the sidebar.
 *
 * Backend /files refuses .md uploads, so dropped .md files go through the
 * notes API instead. Two-step: POST /notes creates an empty file (matching
 * the existing POST /notes contract), then PUT /notes/{id} populates the body.
 *
 * Errors:
 *   - 409 from POST: case-collision or parent_path doesn't resolve to a folder.
 *   - 400 from POST: invalid title chars / traversal.
 *   - PUT failure after POST: the empty .md remains; throws.
 *
 * @param notePath relative path including filename ("docs/foo.md" or "foo.md")
 * @param body markdown content to write to the new note
 */
export async function createNoteFromMarkdownDrop(
  notePath: string,
  body: string,
): Promise<{ id: string; path: string }> {
  const lastSlash = notePath.lastIndexOf("/");
  const parentPath = lastSlash === -1 ? "" : notePath.slice(0, lastSlash);
  const filename = lastSlash === -1 ? notePath : notePath.slice(lastSlash + 1);
  const title = filename.toLowerCase().endsWith(".md")
    ? filename.slice(0, -3)
    : filename;

  const { data, error, response } = await client.POST("/notes", {
    body: { parent_path: parentPath, title },
  });
  if (error || !data) {
    const status = response.status;
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "createNote failed";
    const err = new Error(
      `createNoteFromMarkdownDrop: POST /notes failed (${status} ${code}): ${message}`,
    ) as Error & { status?: number; code?: string };
    err.status = status;
    err.code = code;
    throw err;
  }

  const note = data;

  if (body.length > 0) {
    const { error: putErr, response: putResp } = await client.PUT("/notes/{id}", {
      params: { path: { id: note.id } },
      body: { content: body },
    });
    if (putErr) {
      const status = putResp.status;
      const err = new Error(
        `createNoteFromMarkdownDrop: PUT /notes/${note.id} failed (${status}); empty note left at ${note.path}`,
      ) as Error & { status?: number };
      err.status = status;
      throw err;
    }
  }

  return { id: note.id, path: note.path };
}
