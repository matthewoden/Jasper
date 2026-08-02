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
import { createKeyedResource } from "./resources";

/**
 * Hard-coded UUID for the scratchpad note. Must match the backend's
 * notes.ScratchpadUUID constant byte-for-byte.
 */
export const ScratchpadUUID =
  "00000000-0000-4000-a000-000000000001" as const;

function fetchNote(id: string, signal?: AbortSignal) {
  return client.GET("/notes/{id}", {
    params: { path: { id } },
    ...(signal ? { signal } : {}),
  });
}

// Note bodies are pass-through — never cached, still coalesced.
// A cached body handed to a save path is a lost-write bug, not a
// stale-render bug (ETag/If-Match live on the note, not this layer).
const noteResource = createKeyedResource(
  "note",
  (id: string) => fetchNote(id),
  { mode: "pass-through" },
);

export function getNote(id: string, options?: { signal?: AbortSignal }) {
  // A signal-carrying caller owns cancellation of its own request; a
  // shared in-flight promise can't honour one caller's abort without
  // breaking every other caller joined to it, so this bypasses the
  // coalescer entirely.
  if (options?.signal) {
    return fetchNote(id, options.signal);
  }
  return noteResource.forKey(id).read();
}

/**
 * getNoteFresh — never joins a request issued before this call (the
 * invalidate-never-joins rule, applied at a call site rather than a
 * resource). Use where the caller
 * already knows server state changed at this instant and a stale
 * pre-change snapshot would be a lost-write risk: save-conflict
 * resolution, an explicit "reload from disk", or the post-rename H1
 * rewrite.
 */
export function getNoteFresh(id: string) {
  return noteResource.forKey(id).invalidate();
}

function fetchNoteByPath(path: string) {
  return client.GET("/notes/by-path", {
    params: { query: { path } },
  });
}

const noteByPathResource = createKeyedResource(
  "noteByPath",
  (path: string) => fetchNoteByPath(path),
  { mode: "pass-through" },
);

export function getNoteByPath(path: string) {
  return noteByPathResource.forKey(path).read();
}

export function updateNote(id: string, content: string, ifMatch?: string) {
  return client.PUT("/notes/{id}", {
    params: { path: { id } },
    body: { content },
    ...(ifMatch ? { headers: { "If-Match": ifMatch } } : {}),
  });
}

/**
 * Reads a PUT error as a 409 stale write, returning the server's current
 * comparator — the value the conflict banner offers as "Save anyway".
 *
 * Null for every other failure, so callers can fall through to generic
 * error handling.
 */
export function staleWriteComparator(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { code?: unknown; current_updated_at?: unknown };
  if (e.code !== "stale_write" || typeof e.current_updated_at !== "string") {
    return null;
  }
  return e.current_updated_at;
}

/** Shape returned by GET /api/v1/notes/search-titles. */
export interface NoteSearchResult {
  id: string;
  title: string;
  folder?: string | null;
  recency_score: number;
  proximity_score?: number | null;
}

async function fetchSearchTitles(
  q: string,
  limit: number,
): Promise<NoteSearchResult[]> {
  const { data, error } = await client.GET("/notes/search-titles", {
    params: { query: { q, limit } },
  });
  if (error) {
    throw new Error("searchTitles: " + JSON.stringify(error));
  }
  return data.results as NoteSearchResult[];
}

// Pass-through, coalesced on q+limit — a wiki-link autocomplete
// keystroke and any other concurrent caller asking for the same q/limit
// collapse to one request.
const searchTitlesResource = createKeyedResource(
  "searchTitles",
  (key: string) => {
    const [q, limit] = JSON.parse(key) as [string, number];
    return fetchSearchTitles(q, limit);
  },
  { mode: "pass-through" },
);

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
  const key = JSON.stringify([q, limit]);
  return searchTitlesResource.forKey(key).read();
}

/**
 * Backend /files refuses .md uploads, so a dropped .md file goes through the notes
 * API instead: POST /notes creates it empty, then PUT /notes/{id} populates the
 * body. If the PUT fails the empty .md remains on disk.
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
