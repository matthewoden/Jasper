/**
 * tagAutocomplete — tag-name CompletionSource inside `tags: [...]` frontmatter.
 *
 * Phase 6 / Plan 06-10 / Task 3.
 *
 * D-07: Tag autocomplete when cursor is inside `tags: [...]` frontmatter array.
 * D-44: NO "Create new tag" row — tags become valid on save (no pre-existence needed).
 *
 * Detection strategy:
 *   isInsideTagsArray uses the same lezer-yaml node-name findings from
 *   SPIKE-FINDINGS.md (Plan 06-01): walk up the ancestor chain from the
 *   cursor's innermost node, look for FlowSequence inside a Pair whose Key
 *   text === "tags" inside Frontmatter.
 *
 *   Fallback (Halt-if-inconclusive gate): if AST walk fails to confirm
 *   the context, we use a regex check on the line text to detect
 *   `tags: [` prefix — documented in Plan 06-10 SUMMARY as "regex fallback".
 *
 * Module-level snapshot pattern (mirrors wikilinkResolver):
 *   MarkdownEditor.tsx calls setTagSnapshot(allTags) in a useEffect.
 *   The source reads the snapshot synchronously on each CompletionContext call.
 *
 * CSS badges:
 *   Each completion's `detail` field shows `(N)` count — rendered by
 *   @codemirror/autocomplete's completion tooltip as a trailing detail chip.
 */
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { FRONTMATTER_NODE_NAME } from "./frontmatterPlugin";
import type { TagWithCount } from "../lib/tagsApi";

// ---------------------------------------------------------------------------
// Module-level snapshot — set by MarkdownEditor.tsx via useEffect.
// ---------------------------------------------------------------------------

let _tagSnapshot: TagWithCount[] = [];

/**
 * Update the tag snapshot used by tagCompletionSource.
 * Called from MarkdownEditor's useEffect whenever useTagBrowser returns new data.
 */
export function setTagSnapshot(tags: TagWithCount[]): void {
  _tagSnapshot = tags;
}

// ---------------------------------------------------------------------------
// isInsideTagsPair — checks ancestry (same logic as tagClickPlugin.ts)
//
// Walk ancestors from the cursor's innermost node:
//   1. Find FlowSequence (confirms we're inside [...])
//   2. Find Pair above FlowSequence
//   3. Pair's first child (key) text === "tags"
//
// Returns false if any step fails (wrong key, no FlowSequence, etc.)
// ---------------------------------------------------------------------------

function isInsideTagsPair(node: SyntaxNode, state: { doc: { sliceString(from: number, to: number): string } }): boolean {
  let cur: SyntaxNode | null = node.parent;
  let foundFlowSequence = false;

  while (cur) {
    if (cur.name === "FlowSequence") {
      foundFlowSequence = true;
    }
    if (cur.name === "Pair" && foundFlowSequence) {
      const key = cur.firstChild;
      if (key && state.doc.sliceString(key.from, key.to) === "tags") {
        return true;
      }
      return false;
    }
    if (cur.name === FRONTMATTER_NODE_NAME) break;
    cur = cur.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// isInsideTagsArray — check if the cursor is inside `tags: [...]`.
//
// Approach:
//   1. Primary: AST walk using lezer-yaml node ancestry (SPIKE-FINDINGS).
//   2. Regex fallback: check the line text before cursor for `tags: [`.
//      This handles cases where the parser hasn't fully parsed the YAML
//      (e.g., incomplete `[` at end of doc).
// ---------------------------------------------------------------------------

function isInsideTagsArray(ctx: CompletionContext): boolean {
  const tree = syntaxTree(ctx.state);
  const innerNode = tree.resolveInner(ctx.pos);

  // Primary: check if the node is inside a tags: [...] array via AST.
  // Walk from the innermost node and check ancestry.
  let cur: SyntaxNode | null = innerNode;
  let insideFrontmatter = false;

  // First check if we're inside frontmatter at all.
  let scanNode: SyntaxNode | null = innerNode;
  while (scanNode) {
    if (scanNode.name === FRONTMATTER_NODE_NAME) {
      insideFrontmatter = true;
      break;
    }
    scanNode = scanNode.parent;
  }

  if (!insideFrontmatter) return false;

  // Check if the current node (or one of its ancestors up to FlowSequence) is
  // inside the tags: [...] Pair.
  cur = innerNode;
  while (cur) {
    if (cur.name === FRONTMATTER_NODE_NAME) break;
    if (isInsideTagsPair(cur, ctx.state)) return true;
    cur = cur.parent;
  }

  // Regex fallback: check the line text before the cursor.
  // Matches patterns like:
  //   "tags: [fo"   (typing inside the array)
  //   "tags: [foo, " (after a comma)
  //   "tags: ["    (empty array, typing first value)
  const line = ctx.state.doc.lineAt(ctx.pos);
  const lineText = line.text;
  const linePrefix = lineText.slice(0, ctx.pos - line.from);

  // Pattern: the line starts with optional whitespace + "tags:", then opens [
  // The cursor must be after the [ and before any closing ]
  const tagArrayPattern = /^\s*tags:\s*\[([^\]]*?)$/;
  if (tagArrayPattern.test(linePrefix)) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// tagCompletionSource — the exported CompletionSource
// ---------------------------------------------------------------------------

/**
 * CompletionSource for tag autocomplete inside `tags: [...]` frontmatter.
 * Register this in autocompletion({ override: [wikilinkCompletionSource, tagCompletionSource] }).
 *
 * D-44: Returns null (no popup) when no matching tags found — NOT a Create row.
 */
export async function tagCompletionSource(
  ctx: CompletionContext,
): Promise<CompletionResult | null> {
  if (!isInsideTagsArray(ctx)) return null;

  // Match any word characters (tag charset: a-z0-9_-) before the cursor.
  // This anchors the completion to the tag being typed.
  const trigger = ctx.matchBefore(/[a-z0-9_-]*$/);
  if (!trigger) return null;

  const typed = trigger.text.toLowerCase();

  // Filter the snapshot by the typed prefix (case-insensitive substring match
  // consistent with backend normalization — D-22 charset is lowercase only).
  const matches = typed === ""
    ? _tagSnapshot  // empty query: show all tags
    : _tagSnapshot.filter((t) => t.name.includes(typed));

  // D-44: no Create row — if no matches, return null to close the popup.
  if (matches.length === 0) return null;

  // UAT follow-up 2026-05-12: custom `type: "tag"` so theme.css styles the
  // completion icon column as a blue `#` instead of the keyword key glyph.
  // No `displayLabel` `#` prefix — that produced a double-hashtag (icon + label)
  // per the second UAT pass; the icon column alone is the visual indicator.
  const options: Completion[] = matches.map((t) => ({
    label: t.name,
    detail: `(${t.count})`, // UI-SPEC Surface 4: count badge
    type: "tag",
    // apply is the tag name string — CM6 replaces the trigger range with this.
    apply: t.name,
  }));

  return {
    from: trigger.from,
    options,
    validFor: /[a-z0-9_-]*/,
  };
}
