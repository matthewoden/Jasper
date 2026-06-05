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
 * 05.5-18: external links open. "External" means either a URL with
 * an http(s):// protocol OR a bare domain-with-TLD (e.g. "test.com",
 * "a.b.org/path"). Bare domains are silently upgraded to https:// at
 * open time.
 *
 * Phase 6 / Plan 06-09: wiki-link branch added alongside the external-link
 * branch. Cmd/Ctrl-click on [[Title]] navigates to the resolved note via
 * setActiveNoteId; Cmd/Ctrl-click on a pending [[Title]] creates the note in
 * the source note's folder (createNoteFromPendingLink) then navigates. Plain
 * click on a wiki-link is inert (D-15). The `data-cmd-held` attribute on the
 * `.cm-editor` element is toggled by document-level keydown/keyup listeners
 * wired in MarkdownEditor — that attribute drives the pointer-cursor CSS (D-16).
 *
 * External links open with `target="_blank"` semantics via window.open
 * with `noopener,noreferrer` so the new tab cannot manipulate the
 * opener via window.opener.
 *
 * Module-level snapshot pattern for React integration:
 *   setWikilinkHandlerCallbacks({ setActiveNoteId, getCurrentSourceFolder })
 *   must be called (from MarkdownEditor's useEffect) to wire the React-layer
 *   callbacks into this CM6 extension. The click handler reads these callbacks
 *   synchronously from the module-level closure without going through React.
 *   This mirrors the wikilinkResolver snapshot pattern.
 */
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { isExternalLikeUrl, ensureProtocol } from "./linkUrl";
import { getResolvedTitlesSnapshot } from "./wikilinkResolver";
import { WIKILINK_RE } from "./wikilinkPlugin";
import { postNotes } from "../lib/treeApi";


interface WikilinkCallbacks {
  setActiveNoteId: (id: string) => void;
  getCurrentSourceFolder: () => string;
}

let _callbacks: WikilinkCallbacks | null = null;

/**
 * Wire the React-layer navigation + source-folder callbacks into the CM6
 * click handler. Called from MarkdownEditor's useEffect. Must be called
 * before any user click on a wiki-link to have effect.
 */
export function setWikilinkHandlerCallbacks(cbs: WikilinkCallbacks): void {
  _callbacks = cbs;
}


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
  return event.metaKey || event.ctrlKey;
}


export interface WikiLinkAtPos {
  rawTitle: string;
  isResolved: boolean;
  targetId: string | null;
}

/**
 * Find a wikilink at the given document position.
 * Scans the line text with WIKILINK_RE and returns the wikilink whose range
 * covers `pos`. Returns null if no wikilink covers the position.
 *
 * Test K7: findWikiLinkAt outside any wikilink returns null.
 */
export function findWikiLinkAt(
  view: EditorView,
  pos: number,
): WikiLinkAtPos | null {
  const line = view.state.doc.lineAt(pos);
  const lineText = view.state.doc.sliceString(line.from, line.to);
  const offset = pos - line.from;

  const re = new RegExp(WIKILINK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (offset >= start && offset <= end) {
      const rawTitle = m[1];
      const { titles, idMap } = getResolvedTitlesSnapshot();
      const lower = rawTitle.normalize("NFC").toLowerCase();
      const resolved = titles.has(lower);
      return {
        rawTitle,
        isResolved: resolved,
        targetId: idMap?.get(lower) ?? null,
      };
    }
  }
  return null;
}

/**
 * Create a new note from a pending wikilink. Posts to /api/v1/notes with
 * `parent_path` = `sourceFolder` and `title` = `rawTitle` (without .md).
 *
 * On success, returns the new note's id. On error, throws so the caller can
 * surface the failure appropriately.
 *
 * Test K8: calls postNotes with parent_path=sourceFolder, title=rawTitle;
 *          on success calls setActiveNoteId with the new note's id.
 *
 * Security (T-06-09-02): the backend validates parent_path and title for
 * path-traversal and illegal chars (Phase 3 Service.Create). Returns 400
 * on bad input — the caller logs the error.
 */
export async function createNoteFromPendingLink(
  rawTitle: string,
  sourceFolder: string,
): Promise<string> {
  const { data, error } = await postNotes({
    parent_path: sourceFolder,
    title: rawTitle,
  });
  if (error || !data) {
    throw new Error(
      error?.message ?? "createNoteFromPendingLink: unknown error",
    );
  }
  return data.id;
}


export const linkClickHandler = EditorView.domEventHandlers({
  click(event, view) {
    if (!isModifierClick(event)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;

    const link = findLinkAt(view, pos);
    if (link) {
      const url = readUrl(view, link);
      if (!url) return false;
      if (!isExternalLikeUrl(url)) {
        // Not external — fall through to wiki-link branch below.
      } else {
        window.open(ensureProtocol(url), "_blank", "noopener,noreferrer");
        event.preventDefault();
        return true;
      }
    }

    const wikiLink = findWikiLinkAt(view, pos);
    if (!wikiLink) return false;

    const cbs = _callbacks;
    if (!cbs) {
      return false;
    }

    if (wikiLink.isResolved && wikiLink.targetId) {
      cbs.setActiveNoteId(wikiLink.targetId);
      event.preventDefault();
      return true;
    }

    if (!wikiLink.isResolved) {
      const sourceFolder = cbs.getCurrentSourceFolder();
      void createNoteFromPendingLink(wikiLink.rawTitle, sourceFolder)
        .then((newId) => cbs.setActiveNoteId(newId))
        .catch((e) =>
          console.error("[jasper] create from pending wiki-link failed:", e),
        );
      event.preventDefault();
      return true;
    }

    return false;
  },
});
