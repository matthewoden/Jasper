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


let _tagSnapshot: TagWithCount[] = [];

/**
 * Update the tag snapshot used by tagCompletionSource.
 * Called from MarkdownEditor's useEffect whenever useTagBrowser returns new data.
 */
export function setTagSnapshot(tags: TagWithCount[]): void {
  _tagSnapshot = tags;
}


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


function isInsideTagsArray(ctx: CompletionContext): boolean {
  const tree = syntaxTree(ctx.state);
  const innerNode = tree.resolveInner(ctx.pos);

  let cur: SyntaxNode | null = innerNode;
  let insideFrontmatter = false;

  let scanNode: SyntaxNode | null = innerNode;
  while (scanNode) {
    if (scanNode.name === FRONTMATTER_NODE_NAME) {
      insideFrontmatter = true;
      break;
    }
    scanNode = scanNode.parent;
  }

  if (!insideFrontmatter) return false;

  cur = innerNode;
  while (cur) {
    if (cur.name === FRONTMATTER_NODE_NAME) break;
    if (isInsideTagsPair(cur, ctx.state)) return true;
    cur = cur.parent;
  }

  const line = ctx.state.doc.lineAt(ctx.pos);
  const lineText = line.text;
  const linePrefix = lineText.slice(0, ctx.pos - line.from);

  const tagArrayPattern = /^\s*tags:\s*\[([^\]]*?)$/;
  if (tagArrayPattern.test(linePrefix)) {
    return true;
  }

  return false;
}


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

  const trigger = ctx.matchBefore(/[a-z0-9_-]*$/);
  if (!trigger) return null;

  const typed = trigger.text.toLowerCase();

  const matches = typed === ""
    ? _tagSnapshot
    : _tagSnapshot.filter((t) => t.name.includes(typed));

  if (matches.length === 0) return null;

  const options: Completion[] = matches.map((t) => ({
    label: t.name,
    detail: String(t.count),
    type: "tag",
    apply: t.name,
  }));

  return {
    from: trigger.from,
    options,
    validFor: /[a-z0-9_-]*/,
  };
}
