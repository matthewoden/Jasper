/**
 * linkClickHandler — Obsidian-style cmd/ctrl-click on markdown links.
 *
 * In an EDITABLE markdown surface, a single click should NOT navigate
 * (the user might be aiming to position the cursor for editing). The
 * convention from VS Code, Obsidian, and most prose editors is:
 *
 *   - Plain click  → caret placement (CM6 default; we don't intercept)
 *   - Cmd-click    → open the link (Mac)
 *   - Ctrl-click   → open the link (Windows / Linux)
 *
 * 05.5-18: only EXTERNAL links (http(s)://) open. Internal / wiki
 * link routing is Phase 6 territory; this handler ignores them so a
 * future phase can layer its own behavior without conflict.
 *
 * External links open with `target="_blank"` semantics via window.open
 * with `noopener,noreferrer` so the new tab cannot manipulate the
 * opener via window.opener.
 */
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

function findLinkAt(view: EditorView, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos);
  while (node && node.name !== "Link") node = node.parent;
  return node;
}

function readUrl(view: EditorView, link: SyntaxNode): string | null {
  const c = link.cursor();
  if (!c.firstChild()) return null;
  do {
    if (c.name === "URL") {
      return view.state.doc.sliceString(c.from, c.to).trim();
    }
  } while (c.nextSibling());
  return null;
}

function isModifierClick(event: MouseEvent): boolean {
  // Open-link gesture: Cmd-click on Mac, Ctrl-click on
  // Windows/Linux. We accept EITHER modifier rather than gating on
  // navigator.platform — Playwright (and Electron, and remote-desktop
  // setups) routinely report "Win32" even on macOS, so a strict
  // platform branch silently dropped Mac users' Cmd-clicks. The cost
  // of accepting both is negligible (no platform-specific binding
  // collides with this gesture in CM6's default keymap or any of our
  // extensions).
  return event.metaKey || event.ctrlKey;
}

export const linkClickHandler = EditorView.domEventHandlers({
  click(event, view) {
    if (!isModifierClick(event)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const link = findLinkAt(view, pos);
    if (!link) return false;
    const url = readUrl(view, link);
    if (!url) return false;
    if (!/^https?:\/\//i.test(url)) {
      // Internal — defer to Phase 6 wiki-link routing. Don't
      // preventDefault; let CM6 handle caret placement normally.
      return false;
    }
    // External — open in a new tab. noopener strips window.opener so
    // the popup can't manipulate the editor; noreferrer also strips
    // the Referer header.
    window.open(url, "_blank", "noopener,noreferrer");
    event.preventDefault();
    return true;
  },
});
