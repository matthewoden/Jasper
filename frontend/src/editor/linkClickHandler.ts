/**
 * Cmd/Ctrl-click navigates a markdown link; a plain click just positions the
 * cursor, which is what an editable surface must keep doing.
 *
 * External URLs open with noopener,noreferrer. A pending [[Title]] is created
 * first, then navigated to.
 *
 * setWikilinkHandlerCallbacks must be wired from MarkdownEditor — this module
 * cannot reach React state itself.
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
 * Returns null when pos is not inside any wikilink on the line.
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
 * On success, returns the new note's id. Throws on API error.
 * The backend validates parent_path and title for path-traversal; returns
 * 400 on bad input — the caller logs the error.
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
