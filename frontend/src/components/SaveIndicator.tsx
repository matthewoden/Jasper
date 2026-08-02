/**
 * SaveIndicator — renders the current SaveState.
 *
 * Without onClick: absolute-positioned overlay in the top-right corner of the
 * host EditorPane (which must set `position: relative`). Returns null when
 * idle so no layout space is reserved.
 *
 * With onClick: icon-only button. Click triggers manual incremental reindex.
 * The button is disabled while status === "saving" to prevent re-entrancy.
 *
 * Locked copy strings (overlay mode, do not paraphrase):
 *   saving → "Saving…"        title="Saving your note"
 *   saved  → "Saved"          title="Saved at HH:MM:SS"
 *   error  → "Save failed"    title="Save failed — your edit is still in the editor. Press ⌘S to retry."
 *
 * Button-mode tooltip: state copy + " — click to refresh", rendered through
 * the shared Tooltip system rather than a native `title` — matching every
 * other status-bar icon control. aria-label is kept for accessibility and
 * E2E stability.
 */

import type { CSSProperties } from "react";
import { AlertCircle, Check, Cloud, CloudOff, Loader2 } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import type { SaveState } from "../lib/saveStateMachine";
import { Tooltip } from "./Tooltip";

interface Props {
  state: SaveState;
  /**
   * When set, renders as a clickable button for manual reindex.
   * Omit to get the legacy read-only overlay.
   */
  onClick?: () => void;
}


const OVERLAY_STYLE: CSSProperties = {
  position: "absolute",
  top: 4,
  right: 8,
  zIndex: 5,
  background: "color-mix(in srgb, var(--color-surface) 90%, transparent)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "2px 8px",
  pointerEvents: "none",
};

const CONTAINER_CLASS =
  "flex items-center justify-end gap-1 text-sm";


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
  if (onClick) {
    const { Icon, spin } = buttonVisualFor(state);
    const tooltip = `${legacyTooltipFor(state)} — click to refresh`;
    const isDisabled = state.status === "saving";
    return (
      <Tooltip label={tooltip}>
        <button
          type="button"
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
      </Tooltip>
    );
  }

  switch (state.status) {
    case "idle":
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
      return null;
  }
}
