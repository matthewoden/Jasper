/**
 * tagAutocomplete — tag-name CompletionSource inside `tags: [...]` frontmatter.
 *
 * No "Create" row — tags become valid on save; no pre-existence needed.
 *
 * Detection: walk lezer-yaml ancestors from cursor looking for FlowSequence
 * inside a Pair whose Key text === "tags" inside Frontmatter. Falls back to a
 * regex check on the line prefix `tags: [` if the AST walk is inconclusive.
 *
 * Module-level snapshot: MarkdownEditor calls setTagSnapshot() in a useEffect;
 * the source reads synchronously on each CompletionContext call.
 * Each completion's `detail` field shows the usage count.
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
 * Register in autocompletion({ override: [wikilinkCompletionSource, tagCompletionSource] }).
 * Returns null (no popup) when no matching tags found — no Create row.
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
