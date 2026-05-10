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
      fontSize: "15px",
      lineHeight: "1.6",
      // Fill the cm-host parent so CM6's internal .cm-scroller takes
      // over scroll for long documents instead of expanding the page.
      // Without this, .cm-editor sizes to its content's intrinsic
      // height and bypasses the host shell's overflow boundary.
      height: "100%",
      width: "100%",
    },
    // UX-10: remove default focus ring on .cm-editor.cm-focused so the editor
    // surface looks like part of the pane, not a discrete widget.
    "&.cm-focused": { outline: "none !important" },
    ".cm-scroller": {
      // CM6 default is overflow: auto only when .cm-editor has a fixed
      // height — make that explicit so the scroller takes over for
      // long documents and the page itself never scrolls.
      overflow: "auto",
    },
    ".cm-content": {
      padding: "16px",
      caretColor: "var(--color-fg)",
      // UX-11: reading-width line wrap. Pitfall 3: max-width on .cm-content
      // ONLY, never on .cm-scroller (clips selection drawing) or .cm-line
      // (breaks long-line wrapping mid-word). See RESEARCH.md §Pitfall 3.
      maxWidth: "72ch", // scope: .cm-content
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--color-fg)",
    },
    "&.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "color-mix(in srgb, var(--color-accent) 25%, transparent)",
    },
    // Frontmatter line decoration (frontmatterPlugin emits cm-frontmatter).
    ".cm-line.cm-frontmatter": {
      backgroundColor: "var(--color-surface-subtle)",
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      paddingLeft: "16px",
      color: "var(--color-muted)",
    },
    // Code block surface (Plan 05-07 extends livePreviewPlugin with cm-codeblock).
    ".cm-codeblock": {
      backgroundColor: "var(--color-surface)",
      border: "1px solid var(--color-border)",
      borderRadius: "6px",
      padding: "12px",
    },
    // Blockquote decoration (Plan 05-07 adds cm-blockquote).
    ".cm-blockquote": {
      borderLeft: "3px solid var(--color-muted)",
      paddingLeft: "12px",
    },
    // Heading line decorations (livePreviewPlugin emits cm-heading-N).
    ".cm-heading-1": { fontSize: "28px", fontWeight: "600", lineHeight: "1.3" },
    ".cm-heading-2": { fontSize: "22px", fontWeight: "600", lineHeight: "1.3" },
    ".cm-heading-3": { fontSize: "18px", fontWeight: "600", lineHeight: "1.4" },
    ".cm-heading-4": { fontSize: "16px", fontWeight: "600", lineHeight: "1.4" },
    ".cm-heading-5": { fontSize: "15px", fontWeight: "600", lineHeight: "1.4" },
    ".cm-heading-6": { fontSize: "14px", fontWeight: "600", lineHeight: "1.4" },
    // Inline emphasis marks (livePreviewPlugin — Decoration.mark).
    ".cm-strong": { fontWeight: "700" },
    ".cm-emphasis": { fontStyle: "italic" },
    // Inline code span (Plan 05-07 extends with cm-inline-code).
    ".cm-inline-code": {
      fontFamily: "var(--font-mono)",
      fontSize: "14px",
      backgroundColor: "color-mix(in srgb, var(--color-fg) 8%, transparent)",
      padding: "0 4px",
      borderRadius: "3px",
    },
    ".cm-marker": { color: "var(--color-muted)" },
    // Bullet glyph for unordered list items (EDIT-04 / UX-16).
    // Rendered by BulletWidget in livePreviewPlugin when ListMark is
    // off-cursor; uses --color-muted so it reads as a UI affordance, not
    // body text. UX-16: fixed-width inline-block 1.5ch box so the column
    // width matches the on-cursor `.cm-marker.cm-list-marker` slot below
    // — the bullet column does not jiggle on cursor cross. The previous
    // padding-based separation was removed because padding contributes to
    // flow-box differently than inline-block fixed-width and would not
    // match the on-cursor raw `- ` rendering (RESEARCH §Pattern 8
    // anti-pattern).
    ".cm-list-bullet": {
      color: "var(--color-muted)",
      display: "inline-block",
      width: "1.5ch",
      textAlign: "left",
    },
    // UX-16: on-cursor `- ` marker gets the SAME fixed-width slot via the
    // cm-list-marker class added in livePreviewPlugin's ListMark branch.
    // Both off-cursor BulletWidget and on-cursor raw `- ` occupy 1.5ch —
    // bullet column stays stable across cursor crossings.
    ".cm-marker.cm-list-marker": {
      display: "inline-block",
      width: "1.5ch",
      textAlign: "left",
    },
    // Find/Replace panel (D-30 — let CM6 default panel theme through).
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
  // Documented hex exceptions — keyword purple, string green, number orange,
  // type-name amber. Scoped to .cm-content only; never bleed into chrome.
  { tag: t.keyword, color: "#c084fc" },
  { tag: t.string, color: "#86efac" },
  { tag: t.number, color: "#fb923c" },
  { tag: t.comment, color: "var(--color-muted)" },
  { tag: t.function(t.variableName), color: "var(--color-accent)" },
  // Documented exception: type-name amber (#fbbf24) does NOT collide with
  // --color-warning; it lives only inside .cm-content (CSS specificity scoped).
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
