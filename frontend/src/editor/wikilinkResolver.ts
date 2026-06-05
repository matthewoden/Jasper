/**
 * wikilinkResolver — title → note-id resolution backed by tree data.
 *
 * Division of responsibility:
 *
 *   FRONTEND (this module):
 *     Answers "does a note with this title exist anywhere in the vault?"
 *     using a case-insensitive Set<string> of lowercase note titles derived
 *     from the current tree snapshot. This is an O(1) existence check.
 *
 *   BACKEND (Plan 06-04, registry.go):
 *     Implements the full D-20 same-folder-then-alphabetical disambiguation
 *     rule and returns the canonical target id for ambiguous titles. The
 *     frontend treats every resolved title as having AT MOST ONE canonical
 *     target id (the one stored in the titleToId map). When multiple notes
 *     share a title, the titleToId map holds whichever id was seen LAST in
 *     tree walk order; click handling for ambiguous links may fall back to
 *     an async server round-trip in Plan 06-10/06-11.
 *
 * NFC normalization: String.prototype.normalize("NFC") applied to all title
 * keys ensures "ñ" typed as n+combining-tilde compares equal to the
 * precomposed "ñ" stored in the tree. Applied at set-build time (the
 * title values from the tree are also NFC-normalized at the same point).
 *
 * Module-level snapshot pattern:
 *   wikilinkPlugin runs inside CM6's synchronous decoration build — it cannot
 *   call React hooks. MarkdownEditor wires a useEffect that calls
 *   setResolvedTitlesSnapshot(resolvedTitles, titleToId) whenever the hook
 *   returns a new Set. The plugin reads the snapshot synchronously.
 *   Alternatives (StateField fed via Annotation, dispatched StateEffect) are
 *   documented here so a later plan can refactor if needed.
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
 * Returns a Set of lowercase, NFC-normalized titles of all notes currently
 * known to the tree. Memoized — only rebuilds when the tree data identity
 * changes. Pair with setResolvedTitlesSnapshot in a useEffect so the CM6
 * plugin can read synchronously.
 *
 * Test R1: 3 notes in tree → set has 3 lowercase titles
 * Test R2: tree update triggers new Set (memo deps change on new tree identity)
 * Test R3: empty/null tree → empty Set
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
 * Resolve a wikilink title against the provided Set of known lowercase titles.
 * Returns { resolved: true, targetId } on a match; { resolved: false, targetId: null } otherwise.
 *
 * Inputs are NFC-normalized so accented-character variants compare equal.
 *
 * Test R4: resolveWikilinkTitle("Foo", set with "foo") → { resolved: true }
 * Test R5: resolveWikilinkTitle("FOO", set with "foo") → { resolved: true } (case-insensitive)
 *
 * Division note: when targetId is null (title found in set but idMap lacks
 * the entry — can happen if the snapshot is stale), the click handler should
 * fall back to an async server lookup. Plan 06-10/06-11 implements this.
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
