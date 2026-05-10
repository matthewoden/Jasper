/**
 * SaveIndicator — renders the current SaveState per 01-UI-SPEC.md
 * §"Save Indicator State Machine".
 *
 * 2026-05-10 — switched from a fixed 24px row at the top of the
 * editor pane to an absolute-positioned overlay. Pre-fix, the row
 * always reserved 24px even when idle, which (after the App-shell
 * viewport-clamp) read as a "blank gap" above the first content
 * line that the user couldn't scroll past. Now the editor content
 * flows from y=0 of the editor pane and the indicator floats over
 * the top-right corner only when there's something to show
 * (saving / saved / error). The host EditorPane section sets
 * `position: relative` so this absolute layer anchors there.
 *
 * Locked copy strings (do not paraphrase):
 *   saving → "Saving…"        title="Saving your note"
 *   saved  → "Saved"          title="Saved at HH:MM:SS"
 *   error  → "Save failed"    title="Save failed — your edit is still in the editor. Press ⌘S to retry."
 */

import type { CSSProperties } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";

import type { SaveState } from "../lib/saveStateMachine";

interface Props {
  state: SaveState;
}

// Floats above the editor pane's top-right corner. zIndex high
// enough to sit above CM6's gutters and overlay decorations but
// below modal dialogs / context menus.
const OVERLAY_STYLE: CSSProperties = {
  position: "absolute",
  top: 4,
  right: 8,
  zIndex: 5,
  // Tinted pill so the indicator reads as overlay-on-content rather
  // than flat chrome. Color-mix with surface keeps the chip visible
  // in both dark and light themes via CSS-variable retargeting.
  background: "color-mix(in srgb, var(--color-surface) 90%, transparent)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "2px 8px",
  // Don't intercept clicks — the editor surface beneath stays
  // selectable through the overlay. Pointer events re-enable for
  // hover/title display via the inner span if/when needed.
  pointerEvents: "none",
};

const CONTAINER_CLASS =
  "flex items-center justify-end gap-1 text-sm";

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function SaveIndicator({ state }: Props) {
  switch (state.status) {
    case "idle":
      // No layout impact when idle — see file header comment.
      return null;

    case "saving":
      return (
        <div
          className={CONTAINER_CLASS}
          style={OVERLAY_STYLE}
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
          style={OVERLAY_STYLE}
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
          style={OVERLAY_STYLE}
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
