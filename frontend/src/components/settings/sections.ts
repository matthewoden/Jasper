/**
 * Section manifest driving the Settings nav. `SectionId`
 * includes both the Templates and Server hidden ids so the shell's data
 * structure supports six sections, but `SECTIONS` has exactly four rendered
 * entries today. Templates stays absent (not hidden, not disabled)
 * until it has content. Server was retired by ADR-002
 * (2026-07-26) — its only control, the bind-address field, could not serve
 * its own motivating use case (see ADR-002 § "The bootstrap paradox") — and
 * stays absent until it gains the MCP port and audit-log controls.
 */

export type SectionId = "appearance" | "editor" | "templates" | "dailyNotes" | "server" | "about";

export interface SectionMeta {
  id: SectionId;
  label: string;
  subtitle: string;
}

// `as const` so importers cannot push onto or mutate a manifest that both
// NavColumn and SettingsDialogShell read as a single source of truth.
export const SECTIONS = [
  { id: "appearance", label: "Appearance", subtitle: "Accent and typography" },
  { id: "editor", label: "Editor", subtitle: "Writing and autosave" },
  { id: "dailyNotes", label: "Daily notes", subtitle: "Note template" },
  { id: "about", label: "About", subtitle: "Vault details" },
] as const satisfies readonly SectionMeta[];

/**
 * Which sections offer a Reset. This is the ONLY source of truth: whether the
 * button renders and what the reset writes are otherwise two independent
 * edits, and a drift between them makes Reset a silent successful no-op.
 * `buildResetPatch` switches exhaustively over this type with no default arm,
 * so adding an id here without a patch case fails `tsc`.
 */
export type ResettableSectionId = "appearance" | "editor" | "dailyNotes";

const RESETTABLE = ["appearance", "editor", "dailyNotes"] as const satisfies readonly ResettableSectionId[];

export function isResettable(id: SectionId): id is ResettableSectionId {
  return (RESETTABLE as readonly SectionId[]).includes(id);
}
