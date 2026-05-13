/**
 * inlineTagAutocomplete — CompletionSource for inline `#tagname` body syntax.
 *
 * Phase 6.5 / Plan 06.5-05 / Task 2 — UX-T-02 / D-14.
 *
 * Trigger: typing `#` in the document body (NOT inside code or frontmatter).
 * Source: module-level snapshot set by MarkdownEditor via setInlineTagSnapshot.
 * Snapshot choice: SEPARATE snapshot from tagAutocomplete's _tagSnapshot.
 *   Rationale: separation of concerns — the two sources serve different
 *   contexts (frontmatter `tags: [...]` vs body `#tagname`). Both are fed
 *   the same data from MarkdownEditor's useEffect but can diverge if needed
 *   without coupling the files. Document this in SUMMARY.
 *
 * Design decisions:
 *   - matchBefore on hashtag+tag-chars pattern: triggers when cursor is after
 *     a "#" followed by valid tag chars (or just "#" alone). "# " won't match.
 *   - from = match.from + 1: completion REPLACES only the tagname part after
 *     "#", so accepting "foo" from "#fo|" produces "#foo" (not "##foo").
 *   - isInsideCodeOrFrontmatter guard copied from wikilinkPlugin (same lezer
 *     nodes); suppresses the popup inside code/frontmatter contexts.
 *   - D-14: NO "Create new tag" row — tags become real on save.
 *   - If no tags match (or snapshot is empty), returns null to close the popup.
 *
 * Integration: register as the third source in MarkdownEditor.tsx:
 *   autocompletion({ override: [wikilinkCompletionSource, tagCompletionSource, inlineTagCompletionSource] })
 *
 * Snapshot update: MarkdownEditor.tsx calls setInlineTagSnapshot(allTags) in
 * the same useEffect that calls setTagSnapshot(allTags) — same timing, same data.
 */
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { TagWithCount } from "../lib/tagsApi";

// ---------------------------------------------------------------------------
// Module-level snapshot — set by MarkdownEditor.tsx via useEffect.
// ---------------------------------------------------------------------------

let _inlineTagSnapshot: TagWithCount[] = [];

/**
 * Update the inline-tag autocomplete snapshot.
 * Called from MarkdownEditor's useEffect whenever useTagBrowser returns new data.
 * Parallel to setTagSnapshot in tagAutocomplete.ts — separate snapshot per D-14
 * separation-of-concerns rationale (see module JSDoc above).
 */
export function setInlineTagSnapshot(tags: TagWithCount[]): void {
  _inlineTagSnapshot = tags;
}

// ---------------------------------------------------------------------------
// D-19 code-context guard (copied verbatim from wikilinkPlugin / inlineTagPlugin)
// ---------------------------------------------------------------------------

/**
 * Returns true if the cursor position is inside any code or frontmatter context.
 * Deliberately copied from wikilinkPlugin.ts for independent testability.
 * Checks these lezer node names: FencedCode, CodeBlock, InlineCode, Frontmatter.
 *
 * Note: CompletionContext uses `context.state` (EditorState), not EditorView;
 * syntaxTree and resolveInner work the same on EditorState.
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

// ---------------------------------------------------------------------------
// inlineTagCompletionSource — the exported CompletionSource
// ---------------------------------------------------------------------------

/**
 * CompletionSource for inline `#tagname` body syntax.
 * Register in autocompletion({ override: [..., inlineTagCompletionSource] }).
 *
 * Returns null (no popup) when:
 *   - Cursor is not after a `#[a-z0-9_-]*` pattern (e.g., `# ` with space)
 *   - Cursor is inside code or frontmatter context
 *   - Snapshot is empty (no tags to suggest)
 *
 * D-14: Never returns a "Create new tag" row.
 */
export async function inlineTagCompletionSource(
  ctx: CompletionContext,
): Promise<CompletionResult | null> {
  // Trigger detection: cursor must be after `#` followed by zero or more tag chars.
  // `# ` (hash + space) won't match because space is not in [a-z0-9_-].
  const match = ctx.matchBefore(/#[a-z0-9_-]*/);
  if (!match) return null;

  // Code-context guard: suppress inside fenced code, inline code, frontmatter
  if (isInsideCodeOrFrontmatterForAutocomplete(ctx, match.from)) return null;

  // `from: match.from + 1` — replace only the part after `#` so acceptance
  // of `foo` from `#fo|` produces `#foo` (not `##foo` or `#fofoo`).
  const from = match.from + 1;

  // The typed prefix (after `#`) — used for filtering.
  const typed = match.text.slice(1).toLowerCase();

  // Filter the snapshot: if typed is empty show all; otherwise filter by substring.
  // Note: @codemirror/autocomplete also does prefix filtering based on the `from`
  // position, but we pre-filter here as well for consistency with tagAutocomplete.
  const matches =
    typed === ""
      ? _inlineTagSnapshot
      : _inlineTagSnapshot.filter((t) => t.name.includes(typed));

  // D-14: no Create row — if no matches, return null to close the popup.
  if (matches.length === 0) return null;

  // UAT follow-up 2026-05-12: custom `type: "tag"` styled as a blue `#` icon
  // in theme.css. No `displayLabel` — second UAT pass flagged a double-hashtag
  // (icon column + label prefix); the icon column alone reads as the
  // indicator. `detail` is the bare count — theme.css styles the
  // completion-detail span on tag rows as a pill badge.
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
