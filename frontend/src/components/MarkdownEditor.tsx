/**
 * MarkdownEditor — CM6 lifecycle owner. Phase 5 D-26..D-29.
 *
 * Container/presenter split:
 *   EditorPane (container)  → owns banners, conflict prompts, deletion
 *                              banner, autosave + saveStateMachine,
 *                              h1Extract pipeline, editorHandlersRef,
 *                              userHasEdited ref, lastNotePath, WS
 *                              handler refs. Phase 4 wiring is intact
 *                              (D-27).
 *   MarkdownEditor (presenter) → owns the EditorView instance, all CM6
 *                                 extensions, the small ref API. Plan
 *                                 05-11 swaps EditorPane's <textarea>
 *                                 for <MarkdownEditor> in a 1:1 read-
 *                                 site mapping.
 *
 * EDIT-01 cursor stability: EditorView is mounted ONCE on mount via
 * useEffect with []. Never destroys/recreates on prop change. Updates
 * flow via view.dispatch from the ref API or via the silent-reload
 * annotation from EditorPane's WS handler.
 *
 * D-32 Save-state preservation: `onChange` fires on user-typed
 * docChanged transactions only — IME composing transactions and
 * server-update annotations are filtered. EditorPane's onChange
 * callback dispatches userTyped to saveStateMachine the same way the
 * <textarea>'s onChange did. The 2s debounce, Cmd+S, and Phase 4
 * `paused` gating all flow through unchanged.
 *
 * D-26 Ref API contract — EditorPane's call sites swap 1:1:
 *   editorRef.current.getContent()    ← textareaRef.current.value
 *   editorRef.current.setContent(s)   ← textareaRef.current.value = s
 *   editorRef.current.applyServerUpdate(s) ← Phase 4 silent reload
 *   editorRef.current.focus()         ← textareaRef.current.focus()
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Annotation } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { autocompletion } from "@codemirror/autocomplete";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

import { jasperEditorTheme, jasperSyntaxHighlighting } from "../editor/themeBridge";
import { livePreviewPlugin } from "../editor/livePreviewPlugin";
import {
  linkClickHandler,
  setWikilinkHandlerCallbacks,
} from "../editor/linkClickHandler";
import { codeblockExpand } from "../editor/codeblockExpand";
import { frontmatterPlugin } from "../editor/frontmatterPlugin";
import { wikilinkPlugin, resolvedTitlesChanged } from "../editor/wikilinkPlugin";
import { codeLanguages } from "../editor/codeLanguages";
import { externalImagePlugin } from "../editor/externalImagePlugin";
import { saveKeymap } from "../editor/jasperKeymap"; // Plan 05-11 / EDIT-10
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
import { useTagBrowser } from "../lib/useTagBrowser";
import { useTreeStore } from "../lib/useTreeStore";
import { useFileTree } from "../lib/useFileTree";
import { postNotes } from "../lib/treeApi";
import type { TreeNode } from "../lib/treeApi";

/**
 * MarkdownEditorRef — the ref API EditorPane consumes (D-26 LOCKED).
 */
export interface MarkdownEditorRef {
  /** Replace the entire document. Triggers onChange (user-driven). */
  setContent(s: string): void;
  /** Read the current document text. Equivalent to textarea.value. */
  getContent(): string;
  /**
   * Replace the entire document AS A SERVER UPDATE — annotated so the
   * onChange callback can recognize and skip the userTyped dispatch
   * (Phase 4 D-10 silent reload).
   */
  applyServerUpdate(s: string): void;
  /** Focus the editor caret. */
  focus(): void;
  /**
   * Phase 5.5 / UX-10: focusEnd — focus the editor AND move caret to
   * end-of-doc in a single dispatch. Used by EditorPane's
   * click-anywhere-to-type host wrapper.
   */
  focusEnd(): void;
}

/**
 * ServerUpdateAnnotation — transactions carrying this annotation are
 * server-driven and MUST NOT trigger onChange in EditorPane (avoids
 * autosave loop on WS reload). Exported for future tests.
 */
export const ServerUpdateAnnotation = Annotation.define<true>();

interface Props {
  /** Initial document text. CAPTURED ONCE; subsequent prop changes
   *  do NOT re-instantiate the editor. Use the ref API for updates. */
  initialDoc: string;
  /** Fires after every user-typed docChanged transaction. NOT fired
   *  during IME composition, NOT fired for server-update annotations. */
  onChange: (doc: string) => void;
  /** Fires when the first H1 line of the doc changes. Plan 05-06+ may
   *  wire this; Plan 05-05 ships the callback shape so EditorPane can
   *  pass through its existing h1Extract pipeline (Phase 3 R2). */
  onH1Change?: (h1: string | null) => void;
  /** Cmd+S handler. Plan 05-10 wires the keymap; Plan 05-05 reserves
   *  the prop so EditorPane's performSave call site is unchanged. */
  onSaveRequested?: () => void;
  /** Phase 5.5 / UX-07: fires when CM6's contenteditable surface loses
   *  focus to ANY element outside the editor. Distinct from React's
   *  onBlur (which fires for focus moves WITHIN the editor too). Wired
   *  via EditorView.domEventHandlers({ blur }) in the extensions array. */
  onBlur?: () => void;
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
        // note.path = "folder/sub/Note.md"; folder = "folder/sub"
        const parts = node.path.split("/");
        parts.pop(); // remove filename
        return parts.join("/"); // "" for root-level notes
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
    { initialDoc, onChange, onH1Change, onSaveRequested, onBlur },
    ref
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);

    // cbRef pattern — RESEARCH §Pattern 1 (line 426-428). The
    // EditorView's updateListener captures its closure ONCE on mount;
    // refreshing the cbRef on every render keeps callbacks current
    // without rebuilding the editor.
    // Phase 5.5 / UX-07: onBlur added to the captured set so the new
    // domEventHandlers({ blur }) extension reads the freshest callback.
    const cbRef = useRef({ onChange, onH1Change, onSaveRequested, onBlur });
    cbRef.current = { onChange, onH1Change, onSaveRequested, onBlur };

    // Phase 6 / Plan 06-09: wiki-link decoration + resolution wiring.
    // useResolvedTitleSet reads from useFileTree and returns a memoized
    // { titleSet, idMap } whenever the tree changes. The module-level
    // snapshot is updated in a useEffect so the CM6 plugin can read it
    // synchronously during decoration build.
    const { titleSet, idMap } = useResolvedTitleSet();
    useEffect(() => {
      setResolvedTitlesSnapshot(titleSet, idMap);
      // After updating the snapshot, dispatch the resolvedTitlesChanged
      // StateEffect so wikilinkPlugin.update() triggers a full createDeco()
      // rebuild. MatchDecorator.updateDeco() only rebuilds on doc/viewport
      // changes; a selection-only dispatch is silently ignored internally.
      // The StateEffect approach is the CM6-idiomatic way to signal that
      // external state changed (rather than hacking the doc or selection).
      const v = viewRef.current;
      if (v) {
        v.dispatch({ effects: resolvedTitlesChanged.of(undefined) });
      }
    }, [titleSet, idMap]);

    // Wire the click-handler callbacks (setActiveNoteId + getCurrentSourceFolder).
    // These must be kept fresh (not stale from mount-time closure) via refs.
    const activeNoteId = useTreeStore((s) => s.activeNoteId);
    const setActiveNote = useTreeStore((s) => s.setActiveNote);
    const setActiveTagFilter = useTreeStore((s) => s.setActiveTagFilter);
    const setTagBrowserExpanded = useTreeStore((s) => s.setTagBrowserExpanded);
    const { tree } = useFileTree();

    // Phase 6 / Plan 06-10: tag autocomplete snapshot — feeds tagCompletionSource.
    // useTagBrowser fetches from GET /api/v1/tags and reacts to WS events.
    const { tags: allTags } = useTagBrowser();

    // Use a ref to keep the callbacks fresh without re-registering effects.
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

    // Phase 6 / Plan 06-10: wire autocomplete callbacks for [[ completion source.
    // createNoteAndNavigate: creates a note via linkClickHandler's create path,
    // then navigates to it. Reads fresh state from wikilinkCbRef each call.
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

    // Phase 6 / Plan 06-10: tag autocomplete snapshot sync.
    // Whenever useTagBrowser returns new data, push it to the module-level
    // snapshot so tagCompletionSource can read it synchronously.
    useEffect(() => {
      setTagSnapshot(allTags ?? []);
    }, [allTags]);

    // Phase 6 / Plan 06-10: tag click handler wiring (D-08).
    // Plain click on a cm-tag-clickable span calls setActiveTagFilter
    // and expands the tag browser section so it's visible.
    useEffect(() => {
      setTagClickHandler((tag: string) => {
        setActiveTagFilter(tag);
        setTagBrowserExpanded(true);
      });
      // Called once — setActiveTagFilter and setTagBrowserExpanded are stable
      // Zustand setters (reference-stable between renders).
    }, [setActiveTagFilter, setTagBrowserExpanded]);

    // D-16 Cmd-held affordance (T-06-09-04: cleanup in useEffect return).
    // Adds/removes data-cmd-held on the .cm-editor root when Cmd/Ctrl is held,
    // so CSS can change the cursor to pointer over wiki-link widgets.
    // Choice: React useEffect (simpler than a CM6 EditorView.domEventHandlers
    // extension since it doesn't need CM6 state and survives plugin teardown).
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
            history(),
            search({ top: true }), // EDIT-11 panel — Plan 05-11 binds Cmd+F
            yamlFrontmatter({ content: markdown({ codeLanguages }) }),
            jasperEditorTheme,
            jasperSyntaxHighlighting,
            frontmatterPlugin,
            livePreviewPlugin,
            wikilinkPlugin, // Phase 6 / Plan 06-09 — [[Title]] decoration
            tagClickPlugin, // Phase 6 / Plan 06-10 — clickable tag values in frontmatter (D-08)
            linkClickHandler, // 05.5-18 — Cmd/Ctrl-click opens external links in a new tab
            externalImagePlugin, // Plan 05-08 — SECURITY-03 external image gate
            // Phase 6 / Plan 06-10 — autocomplete: [[ wiki-links + tag names.
            // override: [] disables lang-markdown's emoji shortcodes (acceptable for
            // v1 — documented tradeoff in wikilinkAutocomplete.ts).
            autocompletion({ override: [wikilinkCompletionSource, tagCompletionSource] }),
            saveKeymap(() => cbRef.current.onSaveRequested?.()), // Plan 05-11 / EDIT-10 — BEFORE defaultKeymap so Cmd+S takes precedence
            // 05.5-18: ```-Enter expands to a bounded fenced block.
            // BEFORE defaultKeymap so it can short-circuit Enter
            // before the default newline handler runs.
            codeblockExpand,
            keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
            // Phase 5.5 / UX-11: enable soft line-wrapping inside .cm-content
            // so long lines wrap at the reading-width clamp set by themeBridge
            // instead of scrolling horizontally forever.
            EditorView.lineWrapping,
            // Phase 5.5 / UX-07: editor blur — fires when CM6's contenteditable
            // surface loses focus to an element outside the editor (e.g. user
            // clicks the sidebar / browser chrome). EditorView.domEventHandlers
            // is editor-scoped (NOT React's onBlur which would also fire for
            // intra-editor focus moves like opening the search panel). The
            // optional-chain on cbRef.current.onBlur keeps the no-prop case safe
            // (RESEARCH §Pitfall A1).
            EditorView.domEventHandlers({
              blur() {
                cbRef.current.onBlur?.();
              },
            }),
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) return;
              if (u.view.composing) return; // D-07/D-31 IME gate
              // Skip onChange for server-driven reloads — D-10.
              for (const tr of u.transactions) {
                if (tr.annotation(ServerUpdateAnnotation)) return;
              }
              const doc = u.state.doc.toString();
              cbRef.current.onChange(doc);
              if (cbRef.current.onH1Change) {
                const m = doc.match(/^# (.+)$/m);
                cbRef.current.onH1Change(m ? m[1].trim() : null);
              }
            }),
          ],
        }),
      });
      viewRef.current = view;

      // E2E test hook — Plan 05-12 / EDIT-11: expose openSearchPanel for
      // Playwright so tests can trigger the panel without fighting macOS
      // browser-chrome interception of Meta+F. Does NOT affect runtime
      // behavior; the window property is used only in Playwright specs.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__jasperOpenSearchPanel = () => openSearchPanel(view);

      return () => {
        view.destroy();
        viewRef.current = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (window as any).__jasperOpenSearchPanel;
      };
      // initialDoc captured ONCE — Phase 5 D-26 / EDIT-01 cursor
      // stability. Subsequent updates flow through the ref API.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
      }),
      []
    );

    // aria-label preserves the "Note content" semantic the textarea era
    // shipped with — App.test.tsx + a11y users keep working without
    // re-querying the editor surface.
    return (
      <div
        ref={hostRef}
        className="cm-host"
        data-testid="markdown-editor"
        role="textbox"
        aria-label="Note content"
        aria-multiline="true"
        style={{
          // Flex-fill within the cm-host-shell so CM6's .cm-editor /
          // .cm-scroller can reach height: 100% and scroll long
          // documents internally instead of expanding the page.
          flex: 1,
          minHeight: 0,
          display: "flex",
        }}
      />
    );
  }
);
