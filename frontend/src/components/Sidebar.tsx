/**
 * Phase 3 sidebar — replaces the Phase 1 hardcoded single-row stub.
 *
 * Structure (UI-SPEC §Sidebar internal structure):
 *   <nav width=260>
 *     <header>NOTES + SidebarToolbar</header>
 *     <FileTree onSelectNote={...} />   (flex: 1; scrolls)
 *   </nav>
 *
 * State ownership: useFileTree owns tree state; useTreeStore owns
 * activeNoteId + expanded. Sidebar itself is a layout shell with one
 * piece of behavior — wiring the toolbar's Refresh button to
 * postAdminReindex("incremental") + useFileTree.refresh().
 *
 * onSelectNote prop hook for App.tsx (Plan 03-07): until then, the
 * default no-op preserves Phase 1+2 App.test.tsx behavior — the
 * scratchpad UUID still drives the EditorPane via the legacy hardcoded
 * path; Plan 03-07 will wire activeNoteId into the editor.
 *
 * onNewNote / onNewFolder are intentional no-ops in 03-06 — Plan 03-07
 * wires the create flow + inline-rename mode. The buttons still render
 * + click without crashing per UI-SPEC §Surface 6.
 */
import { useCallback } from "react";

import { FileTree } from "./FileTree";
import { SidebarToolbar } from "./SidebarToolbar";
import { postAdminReindex } from "../lib/adminApi";
import { useFileTree } from "../lib/useFileTree";

export interface SidebarProps {
  onSelectNote?: (id: string) => void;
}

export function Sidebar({ onSelectNote = () => {} }: SidebarProps) {
  const { refresh } = useFileTree();

  const handleRefresh = useCallback(async () => {
    const { error } = await postAdminReindex("incremental");
    if (error) {
      // Plan 03-07 surfaces a destructive toast here. For 03-06's
      // chassis, we just propagate so the toolbar's catch clears spin.
      const message =
        typeof error === "string"
          ? error
          : (error as { message?: string }).message ?? "refresh failed";
      throw new Error(message);
    }
    await refresh();
  }, [refresh]);

  const handleNewNote = useCallback(() => {
    // TODO(03-07): wire create-note flow + inline rename mode
  }, []);

  const handleNewFolder = useCallback(() => {
    // TODO(03-07): wire create-folder flow + inline rename mode
  }, []);

  return (
    <nav
      className="bg-surface border-r border-border h-full flex flex-col"
      style={{ width: 260 }}
      aria-label="Notes navigation"
    >
      <header
        className="flex items-center justify-between"
        style={{
          height: 32,
          paddingLeft: 16,
          paddingRight: 16,
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <span
          className="text-muted uppercase font-semibold"
          style={{
            fontSize: 12,
            letterSpacing: "0.05em",
            lineHeight: 1.4,
          }}
        >
          NOTES
        </span>
        <SidebarToolbar
          onNewNote={handleNewNote}
          onNewFolder={handleNewFolder}
          onRefresh={handleRefresh}
        />
      </header>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <FileTree onSelectNote={onSelectNote} />
      </div>
    </nav>
  );
}
