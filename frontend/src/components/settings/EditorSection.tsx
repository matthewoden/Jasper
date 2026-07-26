/**
 * EditorSection — the Editor pane. Ships the autosave interval alone
 * (D-03/D-18); font size and line height live on the Appearance pane, and
 * `showProperties`/`autoPair`/`foldGutter`/`lineNumbers`/`lineWidth` have no
 * behavior yet (Phase 34 adds the properties toggle, Phase 37 adds the rest)
 * — rendering a row for any of them now would be an inert control.
 */
import { useCallback, useEffect, useState } from "react";
import { Eyebrow, ControlRow, inputStyle } from "./shared";
import type { SectionProps } from "./types";

export function EditorSection({ config, saveConfig, onSaveError }: SectionProps) {
  const [autosaveMsInput, setAutosaveMsInput] = useState(() => String(config.editor.autosaveMs));
  const [autosaveMsError, setAutosaveMsError] = useState<string | null>(null);

  // Re-seed local input state whenever the persisted value changes underneath
  // us (e.g. a pane Reset landing from the shell).
  useEffect(() => {
    setAutosaveMsInput(String(config.editor.autosaveMs));
  }, [config.editor.autosaveMs]);

  const handleAutosaveMsCommit = useCallback(async () => {
    const value = Number(autosaveMsInput);
    if (!Number.isFinite(value) || value < 250 || value > 10000) {
      setAutosaveMsError("Autosave interval must be between 250 and 10000 ms. Reverted to previous value.");
      setAutosaveMsInput(String(config.editor.autosaveMs));
      return;
    }
    setAutosaveMsError(null);
    const { error } = await saveConfig({
      ...config,
      editor: { ...config.editor, autosaveMs: value },
    });
    if (error) {
      setAutosaveMsError(`Save failed: ${error.message}. Reverted.`);
      setAutosaveMsInput(String(config.editor.autosaveMs));
      onSaveError(error.message);
    } else {
      onSaveError(null);
    }
  }, [autosaveMsInput, config, saveConfig, onSaveError]);

  return (
    <section>
      <Eyebrow text="BEHAVIOR" />
      <ControlRow label="Autosave interval" htmlFor="settings-autosave-ms">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            id="settings-autosave-ms"
            type="number"
            min={250}
            max={10000}
            step={250}
            aria-label="Autosave interval"
            aria-describedby="settings-autosave-ms-helper"
            value={autosaveMsInput}
            onChange={(e) => {
              setAutosaveMsInput(e.target.value);
              setAutosaveMsError(null);
            }}
            onBlur={() => {
              void handleAutosaveMsCommit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAutosaveMsCommit();
            }}
            style={{ ...inputStyle, width: 80 }}
          />
          <span style={{ fontSize: 14, color: "var(--color-muted)" }}>ms</span>
        </div>
        <span
          id="settings-autosave-ms-helper"
          style={{ fontSize: 12, color: "var(--color-muted)", display: "block", marginTop: 4 }}
        >
          250–10000 ms. Changes take effect after reload.
        </span>
        {autosaveMsError && (
          <span
            role="alert"
            style={{ fontSize: 12, color: "var(--color-destructive)", display: "block", marginTop: 4 }}
          >
            {autosaveMsError}
          </span>
        )}
      </ControlRow>
    </section>
  );
}

// Not shipped this phase (D-18 — no inert rows):
//   - editor.showProperties        → Phase 34
//   - editor.autoPair               → Phase 37
//   - editor.foldGutter             → Phase 37
//   - editor.lineNumbers            → Phase 37
//   - editor.lineWidth              → Phase 37
// Font size / line height live on the Appearance pane (D-03), not here.
