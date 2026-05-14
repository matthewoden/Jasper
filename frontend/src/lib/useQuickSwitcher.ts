/**
 * useQuickSwitcher — fuzzy match note titles + recency tiebreaker (D-12, D-13).
 *
 * Empty query → recency-ordered list (most recently opened first), then
 *               updated_at desc for notes not in recency list. Capped at 50.
 * Non-empty query → fuzzysort score order with recency tiebreaker on equal scores.
 *
 * Accepts query as an argument so the caller (CommandMenu) can maintain
 * the input state independently from the sidebar search (separate local React state
 * — not useTreeStore.searchQuery, which is for the full-text search sidebar).
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
  /** ISO 8601 UTC string — used for updated_at desc fallback sort (C2 / UAT #10). */
  updated_at: string;
  score?: number;
}

/**
 * Recursively flatten the tree into a search-friendly note list.
 * Only nodes with kind === "note" are included (folders are skipped).
 * The tree root is Tree["root"] (an array of TreeNode).
 */
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
 *
 * @param query - The current search input. Empty string returns recency-sorted list.
 * @returns Array of NoteHit (up to 50), sorted per the rules above.
 */
export function useQuickSwitcher(query: string): NoteHit[] {
  const { tree } = useFileTree();
  // Selector returns the recentlyOpenedNoteIds array from the store
  const recentlyOpenedNoteIds = useTreeStore((s) => s.recentlyOpenedNoteIds);

  return useMemo(() => {
    if (!tree) return [];

    const all = flattenTree(tree);

    if (!query) {
      // Empty query: recency-first order, then updated_at desc for un-opened notes.
      // C2 fix (UAT #10): ISO 8601 strings sort correctly via localeCompare;
      // descending means b.updated_at before a.updated_at (most recent first).
      const recencyIndex = new Map(recentlyOpenedNoteIds.map((id, i) => [id, i]));
      const sorted = [...all].sort((a, b) => {
        const ai = recencyIndex.get(a.id) ?? Infinity;
        const bi = recencyIndex.get(b.id) ?? Infinity;
        if (ai !== bi) return ai - bi;
        // C2 fix (UAT #10): fall back to updated_at desc so the switcher
        // always has the most recent notes at the top when no recency
        // history exists. ISO 8601 strings sort correctly via localeCompare.
        return b.updated_at.localeCompare(a.updated_at);
      });
      return sorted.slice(0, 50);
    }

    // Non-empty query: fuzzysort over titles, then recency tiebreaker on equal scores.
    const results = fuzzysort.go(query, all, {
      key: "title",
      limit: 50,
      threshold: -10000,
    });

    const recencyIndex = new Map(recentlyOpenedNoteIds.map((id, i) => [id, i]));
    return results
      .map((r) => ({ ...r.obj, score: r.score }))
      .sort((a, b) => {
        const aScore = a.score ?? -Infinity;
        const bScore = b.score ?? -Infinity;
        if (aScore !== bScore) {
          // Higher score = better match → descending
          return bScore - aScore;
        }
        // Equal score: recency tiebreaker (lower index = more recent = better)
        const ai = recencyIndex.get(a.id) ?? Infinity;
        const bi = recencyIndex.get(b.id) ?? Infinity;
        return ai - bi;
      });
  }, [query, recentlyOpenedNoteIds, tree]);
}
