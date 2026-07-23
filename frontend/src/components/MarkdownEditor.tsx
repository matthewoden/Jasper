/**
 * MarkdownEditor — CM6 lifecycle owner (presenter half of the EditorPane split).
 *
 * EditorView is mounted ONCE on mount (useEffect with []) for cursor stability.
 * Updates flow via view.dispatch from the ref API or via ServerUpdateAnnotation
 * for silent WS reloads.
 *
 * onChange fires on user-typed docChanged transactions only — IME composing
 * transactions and server-update annotations are filtered.
 *
 * Ref API: getContent / setContent / applyServerUpdate / focus / focusEnd.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Annotation, Compartment, Prec, RangeSetBuilder, type Transaction } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion } from "@codemirror/autocomplete";
import {
  search,
  openSearchPanel,
  getSearchQuery,
  SearchQuery,
  setSearchQuery as cmSetSearchQuery,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  replaceNext as cmReplaceNext,
  replaceAll as cmReplaceAll,
} from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

import { jasperEditorTheme, jasperSyntaxHighlighting } from "../editor/themeBridge";
import { livePreviewPlugin } from "../editor/livePreviewPlugin";
import { Highlight } from "../editor/highlightExtension";
import {
  linkClickHandler,
  setWikilinkHandlerCallbacks,
} from "../editor/linkClickHandler";
import { codeblockExpand } from "../editor/codeblockExpand";


import {
  frontmatterHideExtension,
  frontmatterToggleKeymap,
  frontmatterBackspaceGuardKeymap,
} from "../editor/frontmatterHidePlugin";
import { firstH1HideExtension } from "../editor/firstH1HidePlugin";
import { firstVisibleBodyLine, makeTitleBodyTraversalKeymap } from "../editor/titleBodyTraversal";
import { calloutFoldExtension } from "../editor/calloutFoldField";
import { tableWidgetExtension } from "../editor/tableWidgetPlugin";
import { rewriteH1 } from "../lib/h1Extract";
import { wikilinkPlugin, resolvedTitlesChanged } from "../editor/wikilinkPlugin";
import { codeLanguages } from "../editor/codeLanguages";
import { externalImagePlugin } from "../editor/externalImagePlugin";
import { imageAttachmentPlugin } from "../editor/imageAttachmentWidget";
import { fileChipPlugin } from "../editor/fileChipWidget";
import { dropPosField, dropIndicatorPlugin } from "../editor/dropIndicatorWidget";
import {
  CheckboxToggleAnnotation,
  checkboxTransactionExtender,
  taskCheckboxPlugin,
} from "../editor/taskCheckboxPlugin";
import { useAttachmentUpload } from "../lib/useAttachmentUpload";
import { saveKeymap, jasperKeymap, listEnterKeymap, findBarKeymap } from "../editor/jasperKeymap";
import {
  getPrimaryView,
  historyExtensionFor,
  registerView,
  syncAnnotation,
  syncDispatch,
  unregisterView,
} from "../lib/sharedDocRegistry";
import {
  tagClickPlugin,
  setTagClickHandler,
} from "../editor/tagClickPlugin";
import {
  useResolvedTitleSet,
  setResolvedTitlesSnapshot,
} from "../editor/wikilinkResolver";
import {
  wikilinkCompletionSource,
  setWikilinkAutocompleteCallbacks,
} from "../editor/wikilinkAutocomplete";
import {
  tagCompletionSource,
  setTagSnapshot,
} from "../editor/tagAutocomplete";
import { inlineTagPlugin } from "../editor/inlineTagPlugin";
import {
  inlineTagCompletionSource,
  setInlineTagSnapshot,
} from "../editor/inlineTagAutocomplete";
import { useTagBrowser } from "../lib/useTagBrowser";
import { useTreeStore } from "../lib/useTreeStore";
import { useFileTree } from "../lib/useFileTree";
import { postNotes } from "../lib/treeApi";
import { extractHeadings, type HeadingInfo } from "../editor/outlineExtract";
import { getNoteFolder } from "../lib/treeNoteLookup";

export interface MarkdownEditorRef {
  /** Replace the entire document. Triggers onChange (user-driven). */
  setContent(s: string): void;
  getContent(): string;
  /** Replace document as a server update — annotated so onChange is NOT fired (avoids autosave loop). */
  applyServerUpdate(s: string): void;
  focus(): void;
  /** Focus and move caret to end-of-doc. Used by EditorPane's click-anywhere-to-type host. */
  focusEnd(): void;
  /** Move the cursor to `from` and smooth-scroll it into view (RSIDE-01 Outline click). */
  scrollToHeading(from: number): void;
  /**
   * Rewrites just the first H1 line via rewriteH1(getContent(), next) and
   * dispatches it as a normal user edit (same as setContent) — fires the
   * EXISTING onChange/onH1Change flow unchanged (D-02: no second rename
   * pathway). No-op if the doc has no H1 line (matches rewriteH1's contract).
   */
  setH1(next: string): void;
  /**
   * Enter the body from the title (D-19/D-20): focuses the view and places
   * the caret on firstVisibleBodyLine() (skipping hidden frontmatter AND the
   * hidden first-H1 line — 31-RESEARCH.md Pitfall 2), at the column nearest
   * measuredX (a pixel X, not a character offset — Pitfall 3). Lands at
   * doc end when there is no visible body content below the hidden regions.
   */
  enterFromTitle(measuredX: number): void;
  /**
   * Search commands (P26, WS-09/D-01) — each guards viewRef.current and
   * dispatches/queries against THIS view's own EditorView, so scoping is
   * naturally per-pane even when the same note is open in two panes.
   */
  setSearchQuery(query: SearchQuery): void;
  findNext(): boolean;
  findPrevious(): boolean;
  replaceNext(): boolean;
  replaceAll(): boolean;
  /** Derives {current, total} from a search cursor over the doc; {0,0} when the query is empty. */
  matchInfo(): { current: number; total: number };
  /** Clears the active search query (dismisses highlight-all). */
  clearSearch(): void;
}

/** Transactions annotated with this are server-driven and skip the onChange callback. */
export const ServerUpdateAnnotation = Annotation.define<true>();

interface Props {
  /**
   * Note this view is editing. Captured once at mount (alongside initialDoc)
   * to key this view's shared-doc-registry registration (WS-10) — the same
   * "construct once, use ref API for the rest" contract initialDoc already
   * follows, since this component is not remounted on noteId change.
   */
  noteId: string;
  /** Initial document text. Captured once — use the ref API for subsequent updates. */
  initialDoc: string;
  /** Fires after every user-typed docChanged transaction; NOT fired during IME or server-update annotations. */
  onChange: (doc: string) => void;
  /** Fires when the first H1 line changes. */
  onH1Change?: (h1: string | null) => void;
  /** Fires with the live H1-H6 heading list after every doc change, and once on mount (RSIDE-01). */
  onHeadingsChange?: (headings: HeadingInfo[]) => void;
  /** Cmd+S handler. */
  onSaveRequested?: () => void;
  /** Fires when CM6's contenteditable loses focus to any element OUTSIDE the editor. */
  onBlur?: () => void;
  /** When true, the document is read-only (deleted-tab keep-alive — D-10). */
  readOnly?: boolean;
  /** Cmd+F handler (P26, WS-09/D-02) — opens the pane's find-only bar. */
  onOpenFind?: () => void;
  /** Cmd+Opt+F handler (P26, WS-09/D-02) — opens the pane's find+replace bar. */
  onOpenFindReplace?: () => void;
  /** ArrowUp from the body's first visible line (D-19/D-20/D-21) — hands off to the title with the measured pixel-X. */
  onCrossToTitle?: (measuredX: number) => void;
}

/** Read-only extension toggled at runtime via a Compartment (view is mounted once). */
function readOnlyExtension(readOnly: boolean) {
  return readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];
}

const jasperSearchMatchMark = Decoration.mark({ class: "cm-jasper-search-match" });
const jasperSearchMatchCurrentMark = Decoration.mark({
  class: "cm-jasper-search-match cm-jasper-search-match-current",
});

function buildSearchMatchDecorations(view: EditorView): DecorationSet {
  const query = getSearchQuery(view.state);
  if (!query.search || !query.valid) return Decoration.none;
  const cursor = query.getCursor(view.state);
  const builder = new RangeSetBuilder<Decoration>();
  const sel = view.state.selection.main;
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    const isCurrent = r.value.from === sel.from && r.value.to === sel.to;
    builder.add(
      r.value.from,
      r.value.to,
      isCurrent ? jasperSearchMatchCurrentMark : jasperSearchMatchMark,
    );
  }
  return builder.finish();
}

/**
 * jasperSearchHighlight — highlight-all-matches with current-match emphasis
 * (P26, WS-09/D-04). CM6's built-in searchHighlighter only paints decorations
 * while its native search PANEL is open (a `panel != null` gate baked into
 * @codemirror/search) — since P26 drives search entirely through the custom
 * FindReplaceBar (no built-in panel is ever opened), this plugin re-derives
 * highlighting directly from the live SearchQuery state field, independent
 * of panel state.
 */
const jasperSearchHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildSearchMatchDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        getSearchQuery(update.state) !== getSearchQuery(update.startState)
      ) {
        this.decorations = buildSearchMatchDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export const MarkdownEditor = forwardRef<MarkdownEditorRef, Props>(
  function MarkdownEditor(
    {
      noteId,
      initialDoc,
      onChange,
      onH1Change,
      onHeadingsChange,
      onSaveRequested,
      onBlur,
      readOnly = false,
      onOpenFind,
      onOpenFindReplace,
      onCrossToTitle,
    },
    ref
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const readOnlyCompartment = useRef(new Compartment());

    const cbRef = useRef({
      onChange,
      onH1Change,
      onHeadingsChange,
      onSaveRequested,
      onBlur,
      onOpenFind,
      onOpenFindReplace,
      onCrossToTitle,
    });
    cbRef.current = {
      onChange,
      onH1Change,
      onHeadingsChange,
      onSaveRequested,
      onBlur,
      onOpenFind,
      onOpenFindReplace,
      onCrossToTitle,
    };

    const { titleSet, idMap } = useResolvedTitleSet();
    useEffect(() => {
      setResolvedTitlesSnapshot(titleSet, idMap);
      const v = viewRef.current;
      if (v) {
        v.dispatch({ effects: resolvedTitlesChanged.of(undefined) });
      }
    }, [titleSet, idMap]);

    const setActiveNote = useTreeStore((s) => s.setActiveNote);
    const setActiveTagFilter = useTreeStore((s) => s.setActiveTagFilter);
    const setTagBrowserExpanded = useTreeStore((s) => s.setTagBrowserExpanded);
    const { tree } = useFileTree();

    const { tags: allTags } = useTagBrowser();

    // WR-04 fix (25-REVIEW.md): keyed by THIS pane's own noteId prop, not the
    // global useTreeStore.activeNoteId. In a split view, a visible-but-not-
    // active pane shows a DIFFERENT note than the active pane, so resolving
    // attachments/wikilinks against the global active note produced broken
    // images and wrong link targets in every inactive pane until the user
    // clicked to activate it.
    const noteIdRef = useRef<string | null>(noteId);
    noteIdRef.current = noteId;

    const wikilinkCbRef = useRef({ noteId, setActiveNote, tree });
    wikilinkCbRef.current = { noteId, setActiveNote, tree };

    useEffect(() => {
      setWikilinkHandlerCallbacks({
        setActiveNoteId: (id: string) => {
          wikilinkCbRef.current.setActiveNote(id);
        },
        getCurrentSourceFolder: () => {
          const { noteId: currentNoteId, tree: t } = wikilinkCbRef.current;
          return getNoteFolder(currentNoteId, t?.root ?? []);
        },
      });
      // Called once — the callbacks read fresh state from wikilinkCbRef.current.
    }, []);

    useEffect(() => {
      setWikilinkAutocompleteCallbacks({
        createNoteAndNavigate: async (rawTitle: string, sourceFolder: string) => {
          const { data, error } = await postNotes({
            parent_path: sourceFolder,
            title: rawTitle,
          });
          if (error || !data) {
            throw new Error(
              (error as { message?: string } | undefined)?.message ??
                "createNoteAndNavigate: unknown error",
            );
          }
          wikilinkCbRef.current.setActiveNote(data.id);
        },
        getCurrentSourceFolder: () => {
          const { noteId: currentNoteId, tree: t } = wikilinkCbRef.current;
          return getNoteFolder(currentNoteId, t?.root ?? []);
        },
      });
      // Called once — callbacks read fresh state from wikilinkCbRef.current.
    }, []);

    useEffect(() => {
      setTagSnapshot(allTags ?? []);
      setInlineTagSnapshot(allTags ?? []);
    }, [allTags]);

    useEffect(() => {
      setTagClickHandler((tag: string) => {
        setActiveTagFilter(tag);
        setTagBrowserExpanded(true);
      });
      // Called once — setActiveTagFilter and setTagBrowserExpanded are stable
      // Zustand setters (reference-stable between renders).
    }, [setActiveTagFilter, setTagBrowserExpanded]);

    const [dropActive, setDropActive] = useState(false);
    // WR-04: scope drag/paste attachment uploads to THIS pane's own note, not
    // the global active note — an inactive split pane must upload into its
    // own note's attachments folder, not whichever note is currently active
    // in a different pane.
    const { dragHandlers, pasteHandler, isDropTargetActive } = useAttachmentUpload(
      noteId
    );
    useEffect(() => {
      setDropActive(isDropTargetActive);
    }, [isDropTargetActive]);

    useEffect(() => {
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.metaKey || e.ctrlKey) {
          viewRef.current?.dom.setAttribute("data-cmd-held", "true");
        }
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (!e.metaKey && !e.ctrlKey) {
          viewRef.current?.dom.removeAttribute("data-cmd-held");
        }
      };
      document.addEventListener("keydown", onKeyDown);
      document.addEventListener("keyup", onKeyUp);
      return () => {
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("keyup", onKeyUp);
      };
    }, []);

    useEffect(() => {
      if (!hostRef.current) return;

      // isPrimary: this view is the first live EditorView registered for
      // noteId — it owns the note's single undo-history timeline (see
      // sharedDocRegistry's historyExtensionFor). Determined once, at mount,
      // same "captured once" contract as noteId/initialDoc above.
      const isPrimary = getPrimaryView(noteId) === null;

      // dispatchTx's closure references `view` before its own initializer
      // completes — safe because dispatchTx is only INVOKED later (on a
      // subsequent view.dispatch() call), by which point `view` is assigned.
      // EditorView does not call the dispatch option synchronously during
      // construction.
      const dispatchTx = (tr: Transaction) => syncDispatch(noteId, tr, view);

      const view: EditorView = new EditorView({
        parent: hostRef.current,
        dispatch: dispatchTx,
        state: EditorState.create({
          doc: initialDoc,
          extensions: [
            readOnlyCompartment.current.of(readOnlyExtension(readOnly)),
            historyExtensionFor(noteId, isPrimary),
            search({ top: true }), // provides the SearchQuery state field; driven by the custom FindReplaceBar (P26, D-01), not the built-in panel
            jasperSearchHighlight, // highlight-all + current-match emphasis, panel-independent (P26, D-04)
            // listEnterKeymap at Prec.high: runs before insertNewlineContinueMarkup (also Prec.high
            // from markdown()) because it is placed EARLIER in the extensions array.
            // Handles nested-empty-item de-indent; falls through to markdown() for all other Enter cases.
            Prec.high(keymap.of([listEnterKeymap])),
            yamlFrontmatter({
              content: markdown({ codeLanguages, base: markdownLanguage, extensions: [Highlight] }),
            }),
            jasperEditorTheme,
            jasperSyntaxHighlighting,
            frontmatterHideExtension, // hide frontmatter by default
            firstH1HideExtension, // hide the first ATX H1 — TitleElement renders it above the editor (READ-01/D-02)
            calloutFoldExtension, // fold state for `[!type]-` callouts (READ-02/D-07); chevron rendered by livePreviewPlugin
            tableWidgetExtension, // GFM tables render as real <table> widgets outside the cursor (READ-04/D-11)
            checkboxTransactionExtender, // CHK-01 toggle shim (char-flip is in taskCheckboxPlugin)
            taskCheckboxPlugin,          // checkbox decorations + click handler — must be BEFORE livePreviewPlugin
            livePreviewPlugin,
            wikilinkPlugin,    // [[Title]] decoration
            tagClickPlugin,    // clickable tag values in frontmatter
            inlineTagPlugin,   // body inline #tagname decoration
            linkClickHandler,  // Cmd/Ctrl-click opens external links in a new tab
            externalImagePlugin, // external image security gate
            imageAttachmentPlugin(noteIdRef), // renders ![alt](attachments/…) below line
            fileChipPlugin(noteIdRef), // renders [name](attachments/…) chip below line
            dropPosField,         // StateField: current drag position (null = hidden)
            dropIndicatorPlugin,  // ViewPlugin: dragover/dragleave/drop listeners
            autocompletion({ override: [wikilinkCompletionSource, tagCompletionSource, inlineTagCompletionSource] }),
            saveKeymap(() => cbRef.current.onSaveRequested?.()), // BEFORE defaultKeymap so Cmd+S takes precedence
            findBarKeymap( // Cmd+F / Cmd+Opt+F open the pane's Find/Replace bar (P26, D-02)
              () => cbRef.current.onOpenFind?.(),
              () => cbRef.current.onOpenFindReplace?.(),
            ),
            frontmatterToggleKeymap, // Cmd-Shift-Y toggles raw frontmatter view
            frontmatterBackspaceGuardKeymap, // D-23: no-ops Backspace at the hidden-frontmatter boundary
            makeTitleBodyTraversalKeymap((x) => cbRef.current.onCrossToTitle?.(x)), // D-19/D-20/D-21: ArrowUp from the first visible body line hands off to the title
            codeblockExpand,
            keymap.of([...jasperKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap]), // jasperKeymap FIRST so Mod-b/Mod-i override defaultKeymap; indentWithTab before defaultKeymap so Tab→indent wins
            EditorView.lineWrapping,
            EditorView.domEventHandlers({
              blur() {
                cbRef.current.onBlur?.();
              },
            }),
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) return;
              if (u.view.composing) return;
              // Outline (RSIDE-01): headings must reflect the doc after EVERY
              // docChanged transaction, including server-driven ones — the
              // initial GET-loaded content and silent WS reloads both dispatch
              // via applyServerUpdate (ServerUpdateAnnotation), which is the
              // OVERWHELMINGLY common way a note's real content first reaches
              // the editor (a brand-new pane mounts with initialDoc="" before
              // the async GET resolves — see EditorPane's `initialDoc={loadStatus
              // === "loaded" ? content : ""}` — then applyServerUpdate dispatches
              // the real content once loaded). Gating this on "not a server
              // update" left Outline showing "No headings" for every note until
              // the user made a live edit — a real, live-browser-only bug this
              // plan's E2E caught (never reproduced by mocked component tests).
              // onChange/onH1Change/checkbox-flush below stay guarded: those DO
              // have side effects (autosave-loop / rename-detection) that must
              // not re-fire for a server-originated document replace.
              if (cbRef.current.onHeadingsChange) {
                cbRef.current.onHeadingsChange(extractHeadings(u.state));
              }
              for (const tr of u.transactions) {
                // ServerUpdateAnnotation: silent WS/initial-load reload (existing).
                // syncAnnotation: a change MIRRORED INTO this view by another
                // pane's syncDispatch (WS-10) — must not re-invoke onChange/
                // onH1Change here, or one keystroke in another pane would
                // double-fire this note's save/rename for every mirrored view.
                if (tr.annotation(ServerUpdateAnnotation) || tr.annotation(syncAnnotation)) return;
              }
              const doc = u.state.doc.toString();
              cbRef.current.onChange(doc);
              if (cbRef.current.onH1Change) {
                const m = doc.match(/^# (.+)$/m);
                cbRef.current.onH1Change(m ? m[1].trim() : null);
              }
              // immediate flush on checkbox toggle — bypass 2s autosave debounce
              const isToggle = u.transactions.some(
                (tr) => tr.annotation(CheckboxToggleAnnotation),
              );
              if (isToggle) {
                cbRef.current.onSaveRequested?.();
              }
            }),
          ],
        }),
      });
      viewRef.current = view;
      registerView(noteId, view, isPrimary);

      // Fire once on mount so the outline populates before the first edit.
      if (cbRef.current.onHeadingsChange) {
        cbRef.current.onHeadingsChange(extractHeadings(view.state));
      }

      // E2E hook: expose openSearchPanel so tests can open the CM6 find panel
      // programmatically without relying on Cmd+F (intercepted by the browser).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__jasperOpenSearchPanel = () => openSearchPanel(view);

      return () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (window as any).__jasperOpenSearchPanel;
        unregisterView(noteId, view);
        // sharedDocRegistry's keep-alive contract (T-25-05-Loss): if this view
        // WAS the note's primary and a survivor remains, unregisterView keeps
        // it registered as primary (still off-DOM, undo history intact) rather
        // than releasing it — getPrimaryView still returning THIS view after
        // the call is exactly that signal. Only destroy when the registry has
        // genuinely let it go (last view for the note, or a promoted survivor
        // took over as primary).
        if (getPrimaryView(noteId) !== view) {
          view.destroy();
        }
        viewRef.current = null;
      };
      // initialDoc/noteId captured ONCE for cursor stability. Subsequent updates use the ref API.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Toggle read-only at runtime without re-mounting the view (preserves cursor/undo).
    useEffect(() => {
      viewRef.current?.dispatch({
        effects: readOnlyCompartment.current.reconfigure(
          readOnlyExtension(readOnly),
        ),
      });
    }, [readOnly]);

    useImperativeHandle(
      ref,
      () => ({
        setContent(s: string) {
          const v = viewRef.current;
          if (!v) return;
          v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: s },
          });
        },
        getContent(): string {
          return viewRef.current?.state.doc.toString() ?? "";
        },
        applyServerUpdate(s: string) {
          const v = viewRef.current;
          if (!v) return;
          v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: s },
            annotations: ServerUpdateAnnotation.of(true),
          });
        },
        focus() {
          viewRef.current?.focus();
        },
        focusEnd() {
          const v = viewRef.current;
          if (!v) return;
          v.focus();
          const docLen = v.state.doc.length;
          v.dispatch({ selection: { anchor: docLen, head: docLen } });
        },
        scrollToHeading(from: number) {
          const v = viewRef.current;
          if (!v) return;
          v.dispatch({
            selection: { anchor: from },
            effects: EditorView.scrollIntoView(from, { y: "start", yMargin: 40 }),
          });
          v.focus();
        },
        setH1(next: string) {
          const v = viewRef.current;
          if (!v) return;
          const current = v.state.doc.toString();
          const rewritten = rewriteH1(current, next);
          if (rewritten === current) return;
          v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: rewritten },
          });
        },
        enterFromTitle(measuredX: number) {
          const v = viewRef.current;
          if (!v) return;
          v.focus();
          const target = firstVisibleBodyLine(v.state);
          if (!target) {
            const docLen = v.state.doc.length;
            v.dispatch({ selection: { anchor: docLen, head: docLen } });
            return;
          }
          // Pixel-coordinate column matching (31-RESEARCH.md Pitfall 3): the
          // title's font size differs from the body's, so a character-index
          // mapping would land at the wrong visual column.
          let pos = target.from;
          try {
            const y = v.coordsAtPos(target.from)?.top;
            if (y !== undefined) {
              pos = v.posAtCoords({ x: measuredX, y }) ?? target.from;
            }
          } catch {
            pos = target.from;
          }
          pos = Math.min(Math.max(pos, target.from), target.to);
          v.dispatch({ selection: { anchor: pos, head: pos } });
        },
        setSearchQuery(query: SearchQuery) {
          const v = viewRef.current;
          if (!v) return;
          v.dispatch({ effects: cmSetSearchQuery.of(query) });
        },
        findNext(): boolean {
          const v = viewRef.current;
          return v ? cmFindNext(v) : false;
        },
        findPrevious(): boolean {
          const v = viewRef.current;
          return v ? cmFindPrevious(v) : false;
        },
        replaceNext(): boolean {
          const v = viewRef.current;
          return v ? cmReplaceNext(v) : false;
        },
        replaceAll(): boolean {
          const v = viewRef.current;
          return v ? cmReplaceAll(v) : false;
        },
        matchInfo(): { current: number; total: number } {
          const v = viewRef.current;
          if (!v) return { current: 0, total: 0 };
          const query = getSearchQuery(v.state);
          if (!query.search || !query.valid) return { current: 0, total: 0 };
          const cursor = query.getCursor(v.state);
          const selFrom = v.state.selection.main.from;
          let total = 0;
          let current = 0;
          let foundCurrent = false;
          for (let r = cursor.next(); !r.done; r = cursor.next()) {
            total++;
            if (!foundCurrent && r.value.to > selFrom) {
              current = total;
              foundCurrent = true;
            }
          }
          if (!foundCurrent && total > 0) current = total;
          return { current, total };
        },
        clearSearch() {
          const v = viewRef.current;
          if (!v) return;
          v.dispatch({ effects: cmSetSearchQuery.of(new SearchQuery({ search: "" })) });
        },
      }),
      []
    );

    return (
      <div
        style={{ flex: 1, minHeight: 0, display: "flex", position: "relative" }}
        className={dropActive ? "cm-drop-target-active" : undefined}
        data-testid="attachment-drop-zone"
        onDragEnter={(e) => dragHandlers.onDragEnter(e.nativeEvent)}
        onDragOver={(e) => dragHandlers.onDragOver(e.nativeEvent)}
        onDragLeave={(e) => dragHandlers.onDragLeave(e.nativeEvent)}
        onDrop={async (e) => {
          const v = viewRef.current;
          if (v) await dragHandlers.onDrop(e.nativeEvent, v);
        }}
        onPaste={async (e) => {
          const v = viewRef.current;
          if (v) await pasteHandler(e.nativeEvent, v);
        }}
      >
        {dropActive && (
          <div className="cm-drop-target-hint" aria-hidden="true">
            Drop to attach
          </div>
        )}
        <div
          ref={hostRef}
          className="cm-host"
          data-testid="markdown-editor"
          role="textbox"
          aria-label="Note content"
          aria-multiline="true"
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
          }}
        />
      </div>
    );
  }
);
