/**
 * SectionProps — the LOCKED contract every Settings pane implements (D-06).
 * The shell (plan 32-10) owns the single `useConfig` instance, the save-error
 * banner, and all restart-badge derivations — a pane never calls `useConfig`
 * itself.
 *
 * Amended 2026-07-27 (32.1 D-05): saveConfig now carries a partial
 * (PATCH), not a whole document — a caller writes only the keys it changed.
 * A whole `Config` remains assignable to `ConfigPatch`, so panes that still
 * spread the full config keep compiling and keep working unchanged.
 */
import type { ApiError, Config, ConfigPatch } from "../../lib/useConfig";

export interface SectionProps {
  config: Config;
  saveConfig: (patch: ConfigPatch) => Promise<{ error?: ApiError }>;
  onSaveError: (message: string | null) => void;
}
