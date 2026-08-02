/**
 * wikilinkResolver answers "does a note with this title exist?" in O(1) off a
 * lowercase title Set. Disambiguation stays on the backend, which owns the
 * same-folder-then-alphabetical rule; the frontend keeps whichever id it saw
 * last, so an ambiguous link may need a server round-trip.
 *
 * NFC normalization happens at set-build time so decomposed and precomposed
 * accents compare equal.
 *
 * Exposed as a module-level snapshot because wikilinkPlugin builds decorations
 * synchronously and cannot call a React hook.
 */

import { useMemo } from "react";
import { useFileTree } from "../lib/useFileTree";
import type { TreeNode } from "../lib/treeApi";


let _titleSet: Set<string> = new Set();
let _idMap: Map<string, string> | null = null;

/**
 * Called by MarkdownEditor's useEffect whenever the resolved-title set
 * changes. Propagates the new set to the CM6 plugin's build path.
 * idMap is optional — when provided, it maps lowercase title → note id.
 */
export function setResolvedTitlesSnapshot(
  set: Set<string>,
  idMap?: Map<string, string>,
): void {
  _titleSet = set;
  _idMap = idMap ?? null;
}

/**
 * Read the current module-level snapshot. Called synchronously from
 * wikilinkPlugin's MatchDecorator.decorate callback.
 */
export function getResolvedTitlesSnapshot(): {
  titles: Set<string>;
  idMap: Map<string, string> | null;
} {
  return { titles: _titleSet, idMap: _idMap };
}


/**
 * Walk the tree recursively, collecting every note's title (NFC-normalized,
 * lowercased) and its id.
 */
function collectNoteTitles(nodes: TreeNode[]): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (node: TreeNode): void => {
    if (node.kind === "note") {
      const key = node.title.normalize("NFC").toLowerCase();
      map.set(key, node.id);
    } else if (node.kind === "folder" && node.children) {
      for (const child of node.children) visit(child);
    }
  };
  for (const node of nodes) visit(node);
  return map;
}

/**
 * Returns a Set of lowercase, NFC-normalized titles of all notes known to
 * the tree. Memoized — only rebuilds when tree identity changes. Pair with
 * setResolvedTitlesSnapshot in a useEffect so the CM6 plugin can read
 * synchronously.
 */
export function useResolvedTitleSet(): {
  titleSet: Set<string>;
  idMap: Map<string, string>;
} {
  const { tree } = useFileTree();

  return useMemo(() => {
    if (!tree || !tree.root) {
      return { titleSet: new Set<string>(), idMap: new Map<string, string>() };
    }
    const map = collectNoteTitles(tree.root);
    return { titleSet: new Set(map.keys()), idMap: map };
  }, [tree]);
}


export interface WikilinkResolution {
  resolved: boolean;
  targetId: string | null;
}

/**
 * Resolve a wikilink title against a Set of known lowercase titles.
 * Returns { resolved: true, targetId } on a match; { resolved: false, targetId: null } otherwise.
 * Input is NFC-normalized so accented-character variants compare equal.
 * When targetId is null (snapshot is stale), the click handler should fall back
 * to an async server lookup.
 */
export function resolveWikilinkTitle(
  rawTitle: string,
  resolvedTitles: Set<string>,
  titleToId: Map<string, string> | null = null,
): WikilinkResolution {
  const key = rawTitle.normalize("NFC").toLowerCase();
  if (!resolvedTitles.has(key)) {
    return { resolved: false, targetId: null };
  }
  const targetId = titleToId?.get(key) ?? null;
  return { resolved: true, targetId };
}
