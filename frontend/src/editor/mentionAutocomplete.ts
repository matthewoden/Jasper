/**
 * mentionAutocomplete — the `@` picker. Searches notes and attachments by
 * name and inserts a reference: a note as `[[Title]]`, or as
 * `[[jasper:note/<id>|Title]]` when the id-links setting is on; a blob as an
 * embed by id. `[[` autocomplete is untouched.
 *
 * The trigger is `@` at a word start followed by non-space text, so an email
 * address or a mid-word @ never opens it. Suppressed inside code and
 * frontmatter like the other sources.
 */
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { searchItems, type ItemSearchHit } from "../lib/itemsApi";

export type { ItemSearchHit };

let _idNoteLinks = false;

/** Mirrors `editor.idNoteLinks`; set from MarkdownEditor when config loads. */
export function setMentionIdNoteLinks(on: boolean): void {
  _idNoteLinks = on;
}

function isInsideCodeOrFrontmatter(ctx: CompletionContext): boolean {
  let node = syntaxTree(ctx.state).resolveInner(ctx.pos);
  while (node) {
    const name = node.name;
    if (name === "FencedCode" || name === "CodeBlock" || name === "InlineCode" || name === "Frontmatter") {
      return true;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

/** The text to insert for a picked item, given the current setting. */
export function mentionInsertion(hit: ItemSearchHit, idNoteLinks = _idNoteLinks): string {
  if (hit.kind === "blob") return `![[${hit.ref}|${hit.title}]]`;
  return idNoteLinks ? `[[${hit.ref}|${hit.title}]]` : `[[${hit.title}]]`;
}

export async function mentionCompletionSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  if (isInsideCodeOrFrontmatter(ctx)) return null;

  const trigger = ctx.matchBefore(/(?:^|\s)@([^\s@]*)$/);
  if (!trigger) return null;
  const at = trigger.text.indexOf("@");
  const from = trigger.from + at;
  const typed = trigger.text.slice(at + 1);
  if (typed.length === 0 && !ctx.explicit) return null;

  let hits: ItemSearchHit[] = [];
  try {
    hits = await searchItems(typed, 10);
  } catch (e) {
    console.warn("[jasper] @ picker: items search failed", e);
  }
  if (hits.length === 0) return null;

  const options: Completion[] = hits.map((hit) => ({
    label: hit.title,
    detail: hit.kind === "blob" ? hit.path : folderOf(hit.path),
    type: hit.kind === "blob" ? "variable" : "text",
    apply(view, _completion, _from, to) {
      view.dispatch({ changes: { from, to, insert: mentionInsertion(hit) } });
    },
  }));

  return { from: from + 1, options, validFor: /[^\s@]*/ };
}

function folderOf(path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : undefined;
}
