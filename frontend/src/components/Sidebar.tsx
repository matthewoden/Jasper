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
 * activeNoteId + expanded. Sidebar itself is a layout shell with
 * toolbar wiring:
 *   - New note / New folder click → useTreeCreateActions().createNoteAt("")
 *     / .createFolderAt("") so the new node is created at the root and
 *     immediately enters inline-rename mode.
 *   - Refresh click → postAdminReindex("incremental"). On error, surface
 *     the locked toast tuple per UI-SPEC §Surface 5
 *     ("Couldn't refresh the index.") AND re-throw so the toolbar's
 *     spin-disabled treatment clears.
 */
import { useCallback } from "react";

import { FileTree } from "./FileTree";
import { SidebarToolbar } from "./SidebarToolbar";
import { useToast } from "./Toast";
import { postAdminReindex } from "../lib/adminApi";
import { useFileTree } from "../lib/useFileTree";
import { useTreeCreateActions } from "../lib/useTreeCreateActions";

export interface SidebarProps {
  onSelectNote?: (id: string) => void;
}

export function Sidebar({ onSelectNote = () => {} }: SidebarProps) {
  const { refresh } = useFileTree();
  const { createNoteAt, createFolderAt } = useTreeCreateActions();
  const { toast } = useToast();

  const handleRefresh = useCallback(async () => {
    const { error } = await postAdminReindex("incremental");
    if (error) {
      const message =
        typeof error === "string"
          ? error
          : ((error as { message?: string }).message ?? "Try again.");
      toast({
        title: "Couldn't refresh the index.",
        description: message,
        variant: "error",
      });
      // Re-throw so the toolbar's catch clears the spin-disabled
      // treatment and the user can immediately try again.
      throw new Error(message);
    }
    await refresh();
  }, [refresh, toast]);

  const handleNewNote = useCallback(() => {
    void createNoteAt("");
  }, [createNoteAt]);

  const handleNewFolder = useCallback(() => {
    void createFolderAt("");
  }, [createFolderAt]);

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
