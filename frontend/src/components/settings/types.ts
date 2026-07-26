/**
 * SectionProps — the LOCKED contract every Settings pane implements (D-06).
 * The shell (plan 32-10) owns the single `useConfig` instance, the save-error
 * banner, and all restart-badge derivations — a pane never calls `useConfig`
 * itself.
 */
import type { ApiError, Config } from "../../lib/useConfig";

export interface SectionProps {
  config: Config;
  saveConfig: (next: Config) => Promise<{ error?: ApiError }>;
  onSaveError: (message: string | null) => void;
}
