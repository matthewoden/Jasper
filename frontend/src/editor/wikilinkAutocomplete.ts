/**
 * wikilinkAutocomplete — `[[` CompletionSource for wiki-link autocomplete.
 *
 * Triggers on `[[`, ranks by server (recency + proximity). Always shows
 * "Create '{typed}'" as the last row. Suppressed inside fenced code, inline
 * code, or frontmatter.
 *
 * CompletionResult.from points AFTER the `[[` (trigger.from + 2) so that
 * accepting a completion does not double up the `[[` the user already typed.
 *
 * Module-level callbacks: MarkdownEditor calls setWikilinkAutocompleteCallbacks()
 * in useEffect to wire React-layer navigation + source-folder callbacks without
 * importing React here. Mirrors the wikilinkResolver / tagClickPlugin pattern.
 *
 * Autocomplete strategy: override: [wikilinkCompletionSource, tagCompletionSource].
 * Trade-off: `override` disables lang-markdown's built-in completions (emoji
 * shortcodes). Acceptable for v1; switch to language-data registration if needed.
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
 * Returns true if the position is inside a code context (fenced code, code
 * block, inline code) or YAML frontmatter. When true, the `[[` autocomplete
 * source returns null — no popup shown.
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
 * CompletionSource for wiki-link autocomplete. Register in
 * autocompletion({ override: [wikilinkCompletionSource, ...] }).
 * Trigger: `[[` followed by zero or more non-bracket, non-newline chars.
 * Result.from: trigger.from + 2 (after [[).
 * On server error: gracefully shows only the Create row.
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
