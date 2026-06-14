/**
 * inlineTagAutocomplete — CompletionSource for inline `#tagname` body syntax.
 *
 * Triggers on `#` in the document body (not inside code or frontmatter).
 * Source is a module-level snapshot set by MarkdownEditor via setInlineTagSnapshot.
 *
 * Separate snapshot from tagAutocomplete's _tagSnapshot: both sources serve
 * different contexts (frontmatter `tags: [...]` vs body `#tagname`) and
 * intentionally avoid coupling.
 *
 * from = match.from + 1 so acceptance replaces only the tagname after "#"
 * (accepting "foo" from "#fo" produces "#foo", not "##foo").
 *
 * Never returns a "Create new tag" row — tags become valid on save.
 * Returns null when no tags match or snapshot is empty.
 */
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { TagWithCount } from "../lib/tagsApi";


let _inlineTagSnapshot: TagWithCount[] = [];

/**
 * setInlineTagSnapshot — updates the snapshot used for inline-tag autocomplete.
 * Called from MarkdownEditor's useEffect whenever tag data changes.
 */
export function setInlineTagSnapshot(tags: TagWithCount[]): void {
  _inlineTagSnapshot = tags;
}


/**
 * Returns true when the cursor is inside code or frontmatter (FencedCode,
 * CodeBlock, InlineCode, Frontmatter). Copied from wikilinkPlugin for
 * independent testability — no shared util to avoid coupling.
 */
function isInsideCodeOrFrontmatterForAutocomplete(
  ctx: CompletionContext,
  pos: number,
): boolean {
  let node = syntaxTree(ctx.state).resolveInner(pos);
  while (node) {
    const name = node.name;
    if (
      name === "FencedCode" ||
      name === "CodeBlock" ||
      name === "InlineCode" ||
      name === "Frontmatter"
    ) {
      return true;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}


/**
 * inlineTagCompletionSource — CompletionSource for body `#tagname` syntax.
 * Register in autocompletion({ override: [..., inlineTagCompletionSource] }).
 *
 * Returns null when: cursor is not after `#[a-z0-9_-]*`, cursor is inside
 * code or frontmatter, or snapshot is empty.
 */
export async function inlineTagCompletionSource(
  ctx: CompletionContext,
): Promise<CompletionResult | null> {
  const match = ctx.matchBefore(/#[a-z0-9_-]*/);
  if (!match) return null;

  if (isInsideCodeOrFrontmatterForAutocomplete(ctx, match.from)) return null;

  const from = match.from + 1;

  const typed = match.text.slice(1).toLowerCase();

  const matches =
    typed === ""
      ? _inlineTagSnapshot
      : _inlineTagSnapshot.filter((t) => t.name.includes(typed));

  if (matches.length === 0) return null;

  const options: Completion[] = matches.map((t) => ({
    label: t.name,
    detail: String(t.count),
    type: "tag",
    apply: t.name,
  }));

  return {
    from,
    options,
    validFor: /^[a-z0-9_-]*$/,
  };
}
