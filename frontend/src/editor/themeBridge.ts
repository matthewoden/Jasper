/**
 * themeBridge — CM6 EditorView.theme that paints every color through
 * var(--color-*) lookups. Single source of truth = the data-theme
 * attribute on <html> (D-16). One DOM mutation flips the entire app
 * AND editor — no JS-side theme dispatch.
 *
 * Token contract (UI-SPEC §Color):
 *   --color-bg, --color-surface, --color-surface-subtle, --color-fg,
 *   --color-muted, --color-border, --color-accent, --color-success,
 *   --color-destructive, --color-warning(-surface).
 *
 * Three documented hex exceptions (UI-SPEC §"CodeMirror syntax
 * highlight palette"): keyword purple, string green, number orange.
 * These are CSS-scoped to .cm-content via the highlight style only —
 * never on chrome.
 *
 * `dark: false` on EditorView.theme is correct (UI-SPEC line 663):
 * we do NOT want CM6's built-in dark/light flag — CSS variables drive
 * the flip, not CM6's mode.
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const jasperEditorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--color-bg)",
      color: "var(--color-fg)",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--editor-font-size)",
      lineHeight: "var(--editor-line-height)",
      height: "100%",
      width: "100%",
    },
    "&.cm-focused": { outline: "none !important" },
    ".cm-scroller": {
      overflow: "auto",
    },
    ".cm-content": {
      padding: "16px 16px 16px 0",
      caretColor: "var(--color-fg)",
      maxWidth: "72ch", // scope: .cm-content
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
    },
    ".cm-codeblock-first": {
      borderTop: "1px solid var(--color-border)",
      borderTopLeftRadius: "6px",
      borderTopRightRadius: "6px",
      paddingTop: "8px",
    },
    ".cm-codeblock-last": {
      borderBottom: "1px solid var(--color-border)",
      borderBottomLeftRadius: "6px",
      borderBottomRightRadius: "6px",
      paddingBottom: "8px",
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
    // Phase 12 / Plan 01 — CHK-01..04 checkbox widget CSS (12-UI-SPEC.md § "CSS Classes Added to themeBridge.ts")
    ".cm-task-checkbox": {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      boxSizing: "border-box",
      width: "0.85em",
      height: "0.85em",
      padding: "0",
      margin: "0 4px 0 0",
      verticalAlign: "-0.1em",
      borderRadius: "3px",
      cursor: "pointer",
      userSelect: "none",
      appearance: "none",
      flexShrink: "0",
    },
    ".cm-task-checkbox[aria-checked='false']": {
      border: "1.5px solid var(--color-border)",
      background: "transparent",
    },
    ".cm-task-checkbox[aria-checked='true']": {
      border: "none",
      background: "var(--color-accent)",
    },
    ".cm-task-checkbox[aria-checked='false']:hover": {
      outline: "2px solid color-mix(in srgb, var(--color-accent) 25%, transparent)",
      outlineOffset: "1px",
    },
    ".cm-task-checkbox[aria-checked='true']:hover": {
      filter: "brightness(1.1)",
    },
    ".cm-task-checkbox:focus-visible": {
      outline: "2px solid var(--color-accent)",
      outlineOffset: "2px",
    },
    // Phase 12 / Plan 01 — CHK-02 struck task text (Decoration.mark on text range only)
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
