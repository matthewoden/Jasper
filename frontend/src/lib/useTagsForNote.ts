/**
 * Per-note tag list: frontmatter `tags:` plus inline `#tagname` body matches.
 * The parsing mirrors backend logic in notes/service.go and must stay in step
 * with it.
 *
 * The charset regex [a-z0-9_-]+ is intentionally restrictive; names are parsed
 * from content and never eval'd or rendered as HTML.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { getNote } from "./notesApi";
import { subscribe } from "./resources";


/**
 * Parse YAML frontmatter tags from a markdown string.
 * Handles two forms:
 *   tags: [foo, bar]           ← inline array
 *   tags:                       ← block sequence
 *     - foo
 *     - bar
 */
function parseFrontmatterTags(content: string): string[] {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const fm = fmMatch[1];

  const inlineMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => /^[a-z0-9_-]+$/.test(t));
  }

  const blockMatch = fm.match(/^tags:\s*\n((?:\s*-\s*.+\n?)*)/m);
  if (blockMatch) {
    return blockMatch[1]
      .split("\n")
      .map((line) => line.replace(/^\s*-\s*/, "").trim().toLowerCase())
      .filter((t) => /^[a-z0-9_-]+$/.test(t));
  }

  return [];
}

/** Parse inline #tag occurrences from the markdown body (outside frontmatter). */
function parseBodyTags(content: string): string[] {
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
  const matches = body.matchAll(/#([a-z0-9_-]+)/g);
  return Array.from(matches, (m) => m[1]);
}

/** Sorted deduplicated union of frontmatter and body tags. Mirrors backend unionTags logic. */
function extractTags(content: string): string[] {
  const fm = parseFrontmatterTags(content);
  const body = parseBodyTags(content);
  const union = Array.from(new Set([...fm, ...body]));
  return union.sort();
}


export interface UseTagsForNoteResult {
  tags: string[];
  loading: boolean;
  error: Error | null;
}

/**
 * useTagsForNote(noteId) — fetches and parses the active note's tag list.
 * Returns empty tags when noteId is null.
 * Refetches on noteId changes and on note:updated / links:rewritten WS events.
 */
export function useTagsForNote(noteId: string | null): UseTagsForNoteResult {
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;

  const fetchTags = useCallback(async () => {
    const id = noteIdRef.current;
    if (!id) {
      setTags([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const { data, error: apiErr } = await getNote(id);
      if (apiErr || !data) {
        throw new Error(
          apiErr
            ? JSON.stringify(apiErr)
            : `getNote(${id}) returned no data`,
        );
      }
      setTags(extractTags(data.content));
      setError(null);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (noteId === null) {
      setTags([]);
      setLoading(false);
      setError(null);
      return;
    }

    void fetchTags();

    const subscriber = () => {
      if (noteIdRef.current) void fetchTags();
    };
    const unsubscribes = [
      subscribe("note:updated", subscriber),
      subscribe("note:created", subscriber),
      subscribe("links:rewritten", subscriber),
    ];

    return () => {
      for (const unsub of unsubscribes) unsub();
    };
  }, [noteId, fetchTags]);

  return { tags, loading, error };
}
