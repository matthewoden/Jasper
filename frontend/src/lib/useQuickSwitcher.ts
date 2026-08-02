/**
 * useQuickSwitcher — fuzzy note-title search with recency tiebreaker.
 *
 * Empty query → recency-ordered (most recently opened first), then updated_at
 * desc, capped at 50.
 * Non-empty query → fuzzysort score order with recency tiebreaker on ties.
 *
 * Query is accepted as an argument so the caller maintains its own input
 * state separately from useTreeStore.searchQuery (which is for FTS5 search).
 */
import { useMemo } from "react";
import fuzzysort from "fuzzysort";
import { useTreeStore } from "./useTreeStore";
import { useFileTree } from "./useFileTree";
import type { Tree, TreeNode } from "./treeApi";

export interface NoteHit {
  id: string;
  title: string;
  path: string;
  /** ISO 8601 UTC string — used for updated_at desc fallback sort. */
  updated_at: string;
  score?: number;
  /**
   * 0-based character positions in `title` that matched the query
   * (fuzzysort's `Result.indexes`), for match highlighting. Only
   * populated for non-empty queries — the empty-query recency branch has no
   * query to match against, so this stays undefined there.
   */
  matchIndexes?: readonly number[];
}

/** Flatten the tree into a note list for search; folders are excluded. */
function flattenTree(tree: Tree): NoteHit[] {
  const notes: NoteHit[] = [];

  function visit(node: TreeNode): void {
    if (node.kind === "note") {
      notes.push({ id: node.id, title: node.title, path: node.path, updated_at: node.updated_at });
    } else if (node.kind === "folder") {
      if (node.children) {
        for (const child of node.children) visit(child);
      }
    }
  }

  for (const node of tree.root) {
    visit(node);
  }
  return notes;
}

/**
 * useQuickSwitcher — fuzzy match note titles + recency tiebreaker.
 * @param query - Empty string returns recency-sorted list (up to 50).
 */
export function useQuickSwitcher(query: string): NoteHit[] {
  const { tree } = useFileTree();
  const recentlyOpenedNoteIds = useTreeStore((s) => s.recentlyOpenedNoteIds);

  return useMemo(() => {
    if (!tree) return [];

    const all = flattenTree(tree);

    if (!query) {
      const recencyIndex = new Map(recentlyOpenedNoteIds.map((id, i) => [id, i]));
      const sorted = [...all].sort((a, b) => {
        const ai = recencyIndex.get(a.id) ?? Infinity;
        const bi = recencyIndex.get(b.id) ?? Infinity;
        if (ai !== bi) return ai - bi;
        return b.updated_at.localeCompare(a.updated_at);
      });
      return sorted.slice(0, 50);
    }

    const results = fuzzysort.go(query, all, {
      key: "title",
      limit: 50,
      threshold: -10000,
    });

    const recencyIndex = new Map(recentlyOpenedNoteIds.map((id, i) => [id, i]));
    return results
      .map((r) => ({ ...r.obj, score: r.score, matchIndexes: r.indexes }))
      .sort((a, b) => {
        const aScore = a.score ?? -Infinity;
        const bScore = b.score ?? -Infinity;
        if (aScore !== bScore) {
          return bScore - aScore;
        }
        const ai = recencyIndex.get(a.id) ?? Infinity;
        const bi = recencyIndex.get(b.id) ?? Infinity;
        return ai - bi;
      });
  }, [query, recentlyOpenedNoteIds, tree]);
}
