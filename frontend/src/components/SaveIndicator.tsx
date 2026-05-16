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
 * 2026-05-15 — Plan 07-37 (UAT-3 N9 / D-55) extends the API: when an
 * `onClick` prop is provided, SaveIndicator renders as an icon-only
 * `<button>` (the unified SaveIndicator-as-refresh-button hybrid that
 * lives in TopBar's right cluster). Click triggers a manual incremental
 * reindex (the prior StatusBar refresh button's behavior). Without
 * `onClick` the legacy read-only overlay render is preserved verbatim
 * so older mounting points (and the tests in C1..C5) still pass.
 *
 * Locked copy strings (legacy overlay, do not paraphrase):
 *   saving → "Saving…"        title="Saving your note"
 *   saved  → "Saved"          title="Saved at HH:MM:SS"
 *   error  → "Save failed"    title="Save failed — your edit is still in the editor. Press ⌘S to retry."
 *
 * Button-mode tooltip (Plan 07-37): legacy state copy + " — click to refresh"
 *   idle    → "All changes synced — click to refresh"
 *   saving  → "Saving your note — click to refresh"  (button is disabled)
 *   saved   → "Saved at HH:MM:SS — click to refresh"
 *   error   → "Save failed — your edit is still in the editor. Press ⌘S to retry. — click to refresh"
 *   paused  → "Offline — saves paused — click to refresh"
 */

import type { CSSProperties } from "react";
import { AlertCircle, Check, Cloud, CloudOff, Loader2 } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import type { SaveState } from "../lib/saveStateMachine";

interface Props {
  state: SaveState;
  /**
   * Plan 07-37: when set, SaveIndicator renders as a clickable `<button>`.
   * The click is the manual-refresh action (POST /admin/reindex?mode=incremental).
   * Omit to preserve the legacy read-only overlay behavior.
   */
  onClick?: () => void;
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

// Plan 07-37: button-mode style — sized to match TopBar's right-cluster
// ToggleButton helper (24×24, 4px padding, transparent background, 4px
// border-radius). Cursor flips to "wait" when disabled (saving).
const BUTTON_STYLE: CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  flexShrink: 0,
};

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

// Locked copy from legacy overlay render — reused verbatim by button mode so
// the tooltip prefix stays identical to what users (and tests C2/C3/C4) saw
// pre-Plan 07-37.
function legacyTooltipFor(state: SaveState): string {
  switch (state.status) {
    case "saving":
      return "Saving your note";
    case "saved": {
      const t = state.savedAt;
      return `Saved at ${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
    }
    case "error":
      return "Save failed — your edit is still in the editor. Press ⌘S to retry.";
    case "paused":
      return "Offline — saves paused";
    case "idle":
    default:
      return "All changes synced";
  }
}

// Button-mode visual lookup — picks the lucide icon + spin flag per state.
// Idle renders a cloud-check icon (always-present button affordance) rather
// than null (which is the legacy overlay's idle behavior).
type LucideIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

function buttonVisualFor(state: SaveState): { Icon: LucideIcon; spin: boolean } {
  switch (state.status) {
    case "saving":
      return { Icon: Loader2, spin: true };
    case "saved":
      return { Icon: Check, spin: false };
    case "error":
      return { Icon: AlertCircle, spin: false };
    case "paused":
      return { Icon: CloudOff, spin: false };
    case "idle":
    default:
      return { Icon: Cloud, spin: false };
  }
}

export function SaveIndicator({ state, onClick }: Props) {
  // ── Plan 07-37 button-mode ──────────────────────────────────────────────
  // When `onClick` is provided, render as the unified SaveIndicator-button
  // hybrid (lives in TopBar's right cluster). Always renders SOMETHING (even
  // for idle) so the affordance stays clickable.
  if (onClick) {
    const { Icon, spin } = buttonVisualFor(state);
    const tooltip = `${legacyTooltipFor(state)} — click to refresh`;
    // T-37-01 DoS guard: rapid-clicking can't queue overlapping reindex POSTs.
    // The button is disabled while a save is in flight (which the autosave
    // path drives via useTreeStore.saveState).
    const isDisabled = state.status === "saving";
    return (
      <button
        type="button"
        title={tooltip}
        aria-label={tooltip}
        data-save-state={state.status}
        onClick={onClick}
        disabled={isDisabled}
        style={{
          ...BUTTON_STYLE,
          opacity: isDisabled ? 0.6 : 1,
          cursor: isDisabled ? "wait" : "pointer",
        }}
      >
        <Icon
          size={14}
          aria-hidden="true"
          className={spin ? "animate-spin" : undefined}
        />
      </button>
    );
  }

  // ── Legacy read-only overlay (no onClick) ───────────────────────────────
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

    case "paused":
      // Legacy overlay had no paused render (paused was added by Plan 07-28
      // for the StatusBar mount which read store state). Return null to
      // preserve "no overlay, no layout impact" semantics for legacy callers.
      return null;
  }
}
