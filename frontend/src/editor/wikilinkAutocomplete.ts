/**
 * wikilinkAutocomplete — `[[` CompletionSource for wiki-link autocomplete.
 *
 * Phase 6 / Plan 06-10 / Task 2.
 *
 * D-13: Triggers on `[[`, ranked by server (recency 60% + proximity 40%)
 * D-14: ALWAYS shows "Create '{typed}'" as the LAST row
 * D-47: Suppressed inside fenced code, inline code, or frontmatter
 *
 * Pitfall 9 (from RESEARCH.md): CompletionResult.from must point to
 * AFTER the `[[` trigger sequence (trigger.from + 2) so that when the
 * user accepts a completion, the inserted text does not double up the `[[`
 * markers that the user already typed.
 *
 * Module-level callbacks pattern (mirrors wikilinkResolver / tagClickPlugin):
 * MarkdownEditor.tsx calls setWikilinkAutocompleteCallbacks() in useEffect
 * to wire the React-layer navigation + source-folder callbacks without
 * requiring this module to import React or access the component tree.
 *
 * autocomplete strategy:
 *   override: [wikilinkCompletionSource, tagCompletionSource]
 * (Documented tradeoff: using `override` disables lang-markdown's built-in
 * completions such as emoji shortcodes. This is acceptable for v1 because
 * Jasper has no emoji shortcode requirement. If needed in future, switch
 * to language-data registration via markdown({ ...extensions }) — see
 * RESEARCH.md Pattern 3.)
 */
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { searchTitles, type NoteSearchResult } from "../lib/notesApi";


interface WikilinkAutocompleteCallbacks {
  /** Called with (rawTitle, sourceFolder) when the user selects Create. */
  createNoteAndNavigate: (rawTitle: string, sourceFolder: string) => Promise<void>;
  /** Returns the current note's folder path (for proximity ranking + create). */
  getCurrentSourceFolder: () => string;
}

let _callbacks: WikilinkAutocompleteCallbacks | null = null;

/**
 * Wire the React-layer callbacks into the autocomplete source.
 * Called from MarkdownEditor's useEffect once on mount.
 */
export function setWikilinkAutocompleteCallbacks(
  cbs: WikilinkAutocompleteCallbacks,
): void {
  _callbacks = cbs;
}


/**
 * Returns true if the position is inside a code context (fenced code,
 * code block, inline code) or inside YAML frontmatter. When true, the
 * `[[` autocomplete source returns null — no popup shown.
 *
 * D-47: suppress in code contexts. D-19: suppress in frontmatter.
 */
function isInsideCodeOrFrontmatter(ctx: CompletionContext): boolean {
  let node = syntaxTree(ctx.state).resolveInner(ctx.pos);
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
 * CompletionSource for wiki-link autocomplete. Register this in
 * MarkdownEditor's autocompletion({ override: [wikilinkCompletionSource, ...] }).
 *
 * Trigger: `[[` followed by zero or more non-bracket, non-newline chars.
 * Result.from: trigger.from + 2 (after [[, Pitfall 9).
 *
 * On server error: gracefully shows only the Create row (W11).
 */
export async function wikilinkCompletionSource(
  ctx: CompletionContext,
): Promise<CompletionResult | null> {
  if (isInsideCodeOrFrontmatter(ctx)) return null;

  const trigger = ctx.matchBefore(/\[\[([^\]\n]*)$/);
  if (!trigger) return null;

  const typed = trigger.text.slice(2);

  let results: NoteSearchResult[] = [];
  try {
    results = await searchTitles(typed, 10);
  } catch (e) {
    console.warn("[jasper] [[ autocomplete: search-titles failed; showing Create row only", e);
  }

  const options: Completion[] = results.map((r) => ({
    label: r.title,
    detail: r.folder ?? undefined,
    type: "text",
    apply(view, _completion, _from, to) {
      view.dispatch({
        changes: { from: trigger.from, to, insert: `[[${r.title}]]` },
      });
    },
  }));

  const createLabel = `Create "${typed}"`;
  options.push({
    label: createLabel,
    type: "keyword",
    boost: -Infinity,
    apply(view, _completion, _from, to) {
      const cbs = _callbacks;
      const sourceFolder = cbs?.getCurrentSourceFolder() ?? "";
      view.dispatch({
        changes: { from: trigger.from, to, insert: `[[${typed}]]` },
      });
      if (cbs) {
        void cbs.createNoteAndNavigate(typed, sourceFolder).catch((e: unknown) => {
          console.error("[jasper] Create from autocomplete failed:", e);
        });
      }
    },
  });

  return {
    from: trigger.from + 2,
    options,
    validFor: /[^\]\n]*/,
  };
}
