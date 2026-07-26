/**
 * Section manifest driving the Settings nav (D-01, D-02). `SectionId`
 * includes `"templates"` so the shell's data structure supports six
 * sections, but `SECTIONS` has exactly five entries this phase — Templates
 * stays absent (not hidden, not disabled) until Phase 35 gives it content.
 */

export type SectionId = "appearance" | "editor" | "templates" | "dailyNotes" | "server" | "about";

export interface SectionMeta {
  id: SectionId;
  label: string;
  subtitle: string;
  hasReset: boolean;
}

export const SECTIONS: SectionMeta[] = [
  { id: "appearance", label: "Appearance", subtitle: "Accent and typography", hasReset: true },
  { id: "editor", label: "Editor", subtitle: "Writing and autosave", hasReset: true },
  { id: "dailyNotes", label: "Daily notes", subtitle: "Folder and template", hasReset: true },
  { id: "server", label: "Server", subtitle: "Network and MCP", hasReset: true },
  { id: "about", label: "About", subtitle: "Vault details", hasReset: false },
];
