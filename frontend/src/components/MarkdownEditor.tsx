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
import { Annotation, Compartment, Prec } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion } from "@codemirror/autocomplete";
import { search, openSearchPanel } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

import { jasperEditorTheme, jasperSyntaxHighlighting } from "../editor/themeBridge";
import { livePreviewPlugin } from "../editor/livePreviewPlugin";
import {
  linkClickHandler,
  setWikilinkHandlerCallbacks,
} from "../editor/linkClickHandler";
import { codeblockExpand } from "../editor/codeblockExpand";


import {
  frontmatterHideExtension,
  frontmatterToggleKeymap,
} from "../editor/frontmatterHidePlugin";
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
import { saveKeymap, jasperKeymap, listEnterKeymap } from "../editor/jasperKeymap";
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
import type { TreeNode } from "../lib/treeApi";
import { extractHeadings, type HeadingInfo } from "../editor/outlineExtract";

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
}

/** Transactions annotated with this are server-driven and skip the onChange callback. */
export const ServerUpdateAnnotation = Annotation.define<true>();

interface Props {
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
}

/** Read-only extension toggled at runtime via a Compartment (view is mounted once). */
function readOnlyExtension(readOnly: boolean) {
  return readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];
}

/**
 * Walk the tree to find the folder path of a given note id.
 * Returns the parent folder path (the directory part of note.path),
 * or "" (vault root) if the note is at the top level or not found.
 */
function getNoteFolder(noteId: string | null, root: TreeNode[]): string {
  if (!noteId) return "";
  const visit = (node: TreeNode): string | null => {
    if (node.kind === "note") {
      if (node.id === noteId) {
        const parts = node.path.split("/");
        parts.pop();
        return parts.join("/");
      }
      return null;
    }
    if (node.kind === "folder" && node.children) {
      for (const child of node.children) {
        const hit = visit(child);
        if (hit !== null) return hit;
      }
    }
    return null;
  };
  for (const node of root) {
    const hit = visit(node);
    if (hit !== null) return hit;
  }
  return "";
}

export const MarkdownEditor = forwardRef<MarkdownEditorRef, Props>(
  function MarkdownEditor(
    { initialDoc, onChange, onH1Change, onHeadingsChange, onSaveRequested, onBlur, readOnly = false },
    ref
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const readOnlyCompartment = useRef(new Compartment());

    const cbRef = useRef({ onChange, onH1Change, onHeadingsChange, onSaveRequested, onBlur });
    cbRef.current = { onChange, onH1Change, onHeadingsChange, onSaveRequested, onBlur };

    const { titleSet, idMap } = useResolvedTitleSet();
    useEffect(() => {
      setResolvedTitlesSnapshot(titleSet, idMap);
      const v = viewRef.current;
      if (v) {
        v.dispatch({ effects: resolvedTitlesChanged.of(undefined) });
      }
    }, [titleSet, idMap]);

    const activeNoteId = useTreeStore((s) => s.activeNoteId);
    const setActiveNote = useTreeStore((s) => s.setActiveNote);
    const setActiveTagFilter = useTreeStore((s) => s.setActiveTagFilter);
    const setTagBrowserExpanded = useTreeStore((s) => s.setTagBrowserExpanded);
    const { tree } = useFileTree();

    const { tags: allTags } = useTagBrowser();

    const noteIdRef = useRef<string | null>(activeNoteId);
    noteIdRef.current = activeNoteId;

    const wikilinkCbRef = useRef({ activeNoteId, setActiveNote, tree });
    wikilinkCbRef.current = { activeNoteId, setActiveNote, tree };

    useEffect(() => {
      setWikilinkHandlerCallbacks({
        setActiveNoteId: (id: string) => {
          wikilinkCbRef.current.setActiveNote(id);
        },
        getCurrentSourceFolder: () => {
          const { activeNoteId: noteId, tree: t } = wikilinkCbRef.current;
          return getNoteFolder(noteId, t?.root ?? []);
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
          const { activeNoteId: noteId, tree: t } = wikilinkCbRef.current;
          return getNoteFolder(noteId, t?.root ?? []);
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
    const { dragHandlers, pasteHandler, isDropTargetActive } = useAttachmentUpload(
      activeNoteId
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

      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: initialDoc,
          extensions: [
            readOnlyCompartment.current.of(readOnlyExtension(readOnly)),
            history(),
            search({ top: true }), // searchKeymap omitted; browser native Cmd+F fires instead
            // listEnterKeymap at Prec.high: runs before insertNewlineContinueMarkup (also Prec.high
            // from markdown()) because it is placed EARLIER in the extensions array.
            // Handles nested-empty-item de-indent; falls through to markdown() for all other Enter cases.
            Prec.high(keymap.of([listEnterKeymap])),
            yamlFrontmatter({ content: markdown({ codeLanguages, base: markdownLanguage }) }),
            jasperEditorTheme,
            jasperSyntaxHighlighting,
            frontmatterHideExtension, // hide frontmatter by default
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
            frontmatterToggleKeymap, // Cmd-Shift-Y toggles raw frontmatter view
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
                if (tr.annotation(ServerUpdateAnnotation)) return;
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
        view.destroy();
        viewRef.current = null;
      };
      // initialDoc captured ONCE for cursor stability. Subsequent updates use the ref API.
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
