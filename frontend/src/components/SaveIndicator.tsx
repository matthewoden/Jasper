/**
 * SaveIndicator — renders the current SaveState per 01-UI-SPEC.md
 * §"Save Indicator State Machine". Constant 24px-tall row so the textarea
 * below never reflows on transition. Right-aligned, padding-right 16px (md),
 * vertical padding 4px (xs). ARIA live region announces transitions to
 * screen readers.
 *
 * Locked copy strings (do not paraphrase):
 *   saving → "Saving…"        title="Saving your note"
 *   saved  → "Saved"          title="Saved at HH:MM:SS"
 *   error  → "Save failed"    title="Save failed — your edit is still in the editor. Press ⌘S to retry."
 *
 * Lucide icons: Loader2 (spin) / Check / AlertCircle. Colors via Tailwind v4
 * utilities sourced from theme.css @theme tokens — text-accent / text-success
 * / text-destructive.
 */

import { AlertCircle, Check, Loader2 } from "lucide-react";

import type { SaveState } from "../lib/saveStateMachine";

interface Props {
  state: SaveState;
}

// h-6 = 24px, px-4 = 16px, py-1 = 4px (tailwind v4 default scale; matches the
// UI-SPEC §Spacing Scale md=16px / xs=4px values exactly).
const CONTAINER_CLASS =
  "flex items-center justify-end gap-1 px-4 py-1 h-6 text-sm";

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function SaveIndicator({ state }: Props) {
  switch (state.status) {
    case "idle":
      return (
        <div
          className={CONTAINER_CLASS}
          role="status"
          aria-live="polite"
          aria-label="Save status: idle"
        />
      );

    case "saving":
      return (
        <div
          className={CONTAINER_CLASS}
          role="status"
          aria-live="polite"
          title="Saving your note"
        >
          <Loader2
            className="text-accent animate-spin"
            size={14}
            aria-hidden="true"
          />
          <span className="text-muted">Saving…</span>
        </div>
      );

    case "saved": {
      const hh = pad2(state.savedAt.getHours());
      const mm = pad2(state.savedAt.getMinutes());
      const ss = pad2(state.savedAt.getSeconds());
      return (
        <div
          className={CONTAINER_CLASS}
          role="status"
          aria-live="polite"
          title={`Saved at ${hh}:${mm}:${ss}`}
        >
          <Check className="text-success" size={14} aria-hidden="true" />
          <span className="text-muted">Saved</span>
        </div>
      );
    }

    case "error":
      return (
        <div
          className={CONTAINER_CLASS}
          role="status"
          aria-live="polite"
          title="Save failed — your edit is still in the editor. Press ⌘S to retry."
        >
          <AlertCircle
            className="text-destructive"
            size={14}
            aria-hidden="true"
          />
          <span className="text-destructive">Save failed</span>
        </div>
      );
  }
}
