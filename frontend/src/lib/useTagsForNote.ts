/**
 * useTagsForNote — per-note tag list hook (Plan 07-35 / UAT-3 N3).
 *
 * Replaces TopBar's incorrect use of useTagBrowser() which returns ALL global
 * tags in the vault. useTagsForNote(activeNoteId) fetches only the tags that
 * belong to the ACTIVE NOTE, making hasContent per-note-accurate.
 *
 * Implementation (Option B from 07-35-INVESTIGATION.md):
 *   - Calls getNote(noteId) to retrieve the note's markdown content.
 *   - Parses tags from two sources (mirrors backend logic in notes/service.go):
 *       1. YAML frontmatter: `tags: [foo, bar]` or multi-line `tags:\n  - foo`
 *       2. Inline body tags: `#tagname` patterns (charset: [a-z0-9_-]+)
 *   - Refetches on `note:updated` WS events (subscribed via dispatchLinksEvent,
 *     same fan-out mechanism as useBacklinks per Plan 06-11).
 *   - Cancels in-flight requests when noteId changes (cleanup fn in useEffect).
 *
 * Security (T-35-01): tag names are parsed from content — never eval'd or
 * rendered as HTML. The charset regex limits names to [a-z0-9_-]+.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { getNote } from "./notesApi";
import { linksEventSubscribers } from "./useBacklinks";


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

/**
 * Parse inline #tag occurrences from the markdown body (outside frontmatter).
 * Charset: [a-z0-9_-]+ (matches backend D-22 rule).
 */
function parseBodyTags(content: string): string[] {
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
  const matches = body.matchAll(/#([a-z0-9_-]+)/g);
  return Array.from(matches, (m) => m[1]);
}

/**
 * Compute the canonical tag union: sort(dedupe(frontmatterTags ∪ bodyTags)).
 * Mirrors backend notes/service.go:unionTags.
 */
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
 * useTagsForNote(noteId) — fetches the active note's content and returns its
 * parsed tag list. Returns empty tags when noteId is null.
 *
 * Reactivity: refetches on noteId changes AND on `note:updated` / `note:created`
 * / `links:rewritten` WS events (via the shared linksEventSubscribers set from
 * useBacklinks — same module-level fan-out, zero new infrastructure).
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
    linksEventSubscribers.add(subscriber);

    return () => {
      linksEventSubscribers.delete(subscriber);
    };
  }, [noteId, fetchTags]);

  return { tags, loading, error };
}
