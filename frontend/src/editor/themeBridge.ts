/**
 * themeBridge — CM6 EditorView.theme that paints every color through
 * var(--color-*) lookups. Single source of truth = the data-theme
 * attribute on <html>. One DOM mutation flips the entire app and editor —
 * no JS-side theme dispatch.
 *
 * Token contract: --color-bg, --color-surface, --color-surface-subtle,
 * --color-fg, --color-muted, --color-border, --color-accent, --color-success,
 * --color-destructive, --color-warning(-surface).
 *
 * Three fixed hex exceptions (syntax highlight only, scoped to .cm-content):
 * keyword purple, string green, number orange.
 *
 * `dark: false` on EditorView.theme is intentional — CSS variables drive the
 * dark/light flip, not CM6's built-in mode flag.
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const jasperEditorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--color-bg)",
      color: "var(--color-fg)",
      fontFamily: "var(--font-reading)",
      fontSize: "var(--editor-font-size)",
      lineHeight: "var(--editor-line-height)",
      height: "100%",
      width: "100%",
    },
    "&.cm-focused": { outline: "none !important" },
    ".cm-scroller": {
      overflow: "auto",
      width: "100%",
    },
    ".cm-content": {
      // D-14/D-15/D-17: 760px centered reading column. margin:auto centers
      // the column against the full-width .cm-editor/.cm-scroller parent
      // chain; boxSizing:border-box keeps 760px the OUTER width (Pitfall 4)
      // so padding doesn't push the rendered column past 760px.
      maxWidth: "760px",
      margin: "0 auto",
      padding: "44px 56px 200px",
      boxSizing: "border-box",
      caretColor: "var(--color-fg)",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--color-fg)",
    },
    "&.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "color-mix(in srgb, var(--color-accent) 25%, transparent)",
    },
    ".cm-line.cm-frontmatter": {
      backgroundColor: "var(--color-surface-subtle)",
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      paddingLeft: "16px",
      color: "var(--color-muted)",
    },
    ".cm-codeblock": {
      backgroundColor: "var(--color-surface)",
      borderLeft: "1px solid var(--color-border)",
      borderRight: "1px solid var(--color-border)",
      paddingLeft: "12px",
      paddingRight: "12px",
      fontFamily: "var(--font-mono)",
    },
    ".cm-codeblock-first": {
      borderTop: "1px solid var(--color-border)",
      borderTopLeftRadius: "6px",
      borderTopRightRadius: "6px",
      paddingTop: "8px",
      fontFamily: "var(--font-mono)",
    },
    ".cm-codeblock-last": {
      borderBottom: "1px solid var(--color-border)",
      borderBottomLeftRadius: "6px",
      borderBottomRightRadius: "6px",
      paddingBottom: "8px",
      fontFamily: "var(--font-mono)",
    },
    ".cm-link": {
      color: "var(--color-accent)",
      textDecoration: "underline",
      textDecorationColor:
        "color-mix(in srgb, var(--color-accent) 50%, transparent)",
      textUnderlineOffset: "2px",
      cursor: "text",
    },
    ".cm-link-external": {
      color: "var(--color-accent)",
    },
    ".cm-link:hover": {
      textDecorationColor: "var(--color-accent)",
    },
    ".cm-external-link-icon": {
      color: "var(--color-muted)",
      fontSize: "0.85em",
      marginLeft: "2px",
      verticalAlign: "0.05em",
      pointerEvents: "none",
    },
    ".cm-blockquote": {
      borderLeft: "3px solid var(--color-muted)",
      paddingLeft: "12px",
    },
    ".cm-heading-1": { fontSize: "28px", fontWeight: "600", lineHeight: "1.3" },
    ".cm-heading-2": { fontSize: "22px", fontWeight: "600", lineHeight: "1.3" },
    ".cm-heading-3": { fontSize: "18px", fontWeight: "600", lineHeight: "1.4" },
    ".cm-heading-4": { fontSize: "16px", fontWeight: "600", lineHeight: "1.4" },
    ".cm-heading-5": { fontSize: "15px", fontWeight: "600", lineHeight: "1.4" },
    ".cm-heading-6": { fontSize: "14px", fontWeight: "600", lineHeight: "1.4" },
    ".cm-strong": { fontWeight: "700" },
    ".cm-emphasis": { fontStyle: "italic" },
    ".cm-inline-code": {
      fontFamily: "var(--font-mono)",
      fontSize: "14px",
      backgroundColor: "color-mix(in srgb, var(--color-fg) 8%, transparent)",
      padding: "0 4px",
      borderRadius: "3px",
    },
    ".cm-marker": { color: "var(--color-muted)" },
    ".cm-list-bullet": {
      color: "var(--color-muted)",
      display: "inline-block",
      width: "1.5ch",
      textAlign: "left",
    },
    ".cm-marker.cm-list-marker": {
      display: "inline-block",
      width: "1.5ch",
      textAlign: "left",
    },
    ".cm-panels": {
      backgroundColor: "var(--color-surface)",
      color: "var(--color-fg)",
      borderBottom: "1px solid var(--color-border)",
    },
    ".cm-textfield": {
      backgroundColor: "var(--color-bg)",
      color: "var(--color-fg)",
      border: "1px solid var(--color-border)",
      borderRadius: "4px",
      padding: "4px 8px",
    },
    ".cm-button": {
      backgroundColor: "var(--color-surface)",
      color: "var(--color-fg)",
      border: "1px solid var(--color-border)",
      borderRadius: "4px",
      padding: "4px 8px",
      fontWeight: "400",
    },
    ".cm-searchMatch": {
      backgroundColor: "color-mix(in srgb, var(--color-accent) 18%, transparent)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "color-mix(in srgb, var(--color-accent) 40%, transparent)",
    },
    ".cm-wiki-link": {
      color: "var(--color-accent)",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
      cursor: "text",
    },
    ".cm-wiki-link-pending": {
      color: "color-mix(in srgb, var(--color-fg) 60%, transparent)",
      textDecoration: "underline",
      textDecorationStyle: "dashed",
      textUnderlineOffset: "4px",
      textDecorationColor: "var(--color-muted)",
      cursor: "text",
    },
    "&[data-cmd-held] .cm-wiki-link": { cursor: "pointer" },
    "&[data-cmd-held] .cm-wiki-link-pending": { cursor: "pointer" },
    ".cm-tag-clickable": {
      color: "var(--color-accent)",
      cursor: "pointer",
      textDecoration: "underline",
      textDecorationStyle: "dotted",
      textUnderlineOffset: "2px",
    },
    ".cm-task-checkbox": {
      // Lucide SVG icon container (span element, not a native <input> or <button>).
      // The SVG itself carries the visual — the span is a transparent hit-area wrapper.
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      // Occupy exactly the 3 characters of the raw "[ ]" it replaces so the text
      // doesn't shift horizontally when the line toggles between widget and raw.
      // The icon (sized by height) centers within this slot.
      width: "3ch",
      height: "1.2em",
      padding: "0",
      margin: "0",
      // Center the box on the text x-height rather than the baseline so it sits
      // vertically aligned with the line's letters.
      verticalAlign: "middle",
      cursor: "pointer",
      userSelect: "none",
      flexShrink: "0",
      lineHeight: "1",
    },
    ".cm-task-checkbox:hover": {
      opacity: "0.8",
    },
    ".cm-task-checkbox:focus-visible": {
      outline: "2px solid var(--color-accent)",
      outlineOffset: "2px",
      borderRadius: "3px",
    },
    ".cm-task-text-checked": {
      textDecoration: "line-through",
      textDecorationColor: "var(--color-muted)",
      textDecorationThickness: "1px",
      color: "var(--color-muted)",
    },
  },
  { dark: false }
);

/**
 * jasperHighlightStyle — token-tag → color map for the CM6 syntax
 * highlighter. Most colors flow through var(--color-*); the three
 * documented exceptions (UI-SPEC §"Color exceptions") use fixed hex
 * because they are .cm-content-scoped and sit outside the chrome
 * palette.
 */
export const jasperHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#c084fc" },
  { tag: t.string, color: "#86efac" },
  { tag: t.number, color: "#fb923c" },
  { tag: t.comment, color: "var(--color-muted)" },
  { tag: t.function(t.variableName), color: "var(--color-accent)" },
  { tag: t.typeName, color: "#fbbf24" },
  { tag: t.variableName, color: "var(--color-fg)" },
  { tag: t.punctuation, color: "var(--color-muted)" },
]);

/**
 * jasperSyntaxHighlighting wraps jasperHighlightStyle in the
 * syntaxHighlighting Extension factory so it slots into the editor
 * extension array next to jasperEditorTheme.
 */
export const jasperSyntaxHighlighting = syntaxHighlighting(jasperHighlightStyle);
