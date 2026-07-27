/**
 * DailyNotesSection — the Daily notes pane. Carries the existing folder and
 * template controls over verbatim (D-18 "carried as-is"); the mock's
 * template picker/preview/"New note from template" affordances are Phase 35
 * work (Templates don't exist yet).
 */
import { useCallback, useEffect, useState } from "react";
import { ControlRow, Eyebrow, inputStyle } from "./shared";
import type { SectionProps } from "./types";

const DEFAULT_TEMPLATE = "# {{date}}\n\n";

export function DailyNotesSection({ config, saveConfig, onSaveError }: SectionProps) {
  const [dailyFolder, setDailyFolder] = useState(() => config.dailyNotes.folder);
  const [dailyTemplate, setDailyTemplate] = useState(() => config.dailyNotes.template);

  useEffect(() => {
    setDailyFolder(config.dailyNotes.folder);
  }, [config.dailyNotes.folder]);

  useEffect(() => {
    setDailyTemplate(config.dailyNotes.template);
  }, [config.dailyNotes.template]);

  const handleDailyFolderCommit = useCallback(async () => {
    // WR-06's reproduction site: without this guard, blurring an unedited
    // folder input writes a stale-base copy back over an in-flight save.
    if (dailyFolder === config.dailyNotes.folder) {
      onSaveError(null);
      return;
    }
    const { error } = await saveConfig({ dailyNotes: { folder: dailyFolder } });
    if (error) {
      onSaveError(error.message);
    } else {
      onSaveError(null);
    }
  }, [config, dailyFolder, saveConfig, onSaveError]);

  const handleDailyTemplateCommit = useCallback(async () => {
    if (dailyTemplate === config.dailyNotes.template) {
      onSaveError(null);
      return;
    }
    const { error } = await saveConfig({ dailyNotes: { template: dailyTemplate } });
    if (error) {
      onSaveError(error.message);
    } else {
      onSaveError(null);
    }
  }, [config, dailyTemplate, saveConfig, onSaveError]);

  // No dirty check: this is an explicit button press, not blur drift.
  // Writing the default when the template is already the default is
  // harmless and keeps "calls saveConfig once" honest for that case.
  const handleResetTemplateToDefault = useCallback(async () => {
    setDailyTemplate(DEFAULT_TEMPLATE);
    const { error } = await saveConfig({ dailyNotes: { template: DEFAULT_TEMPLATE } });
    if (error) {
      onSaveError(error.message);
    } else {
      onSaveError(null);
    }
  }, [saveConfig, onSaveError]);

  return (
    <section>
      <Eyebrow text="DAILY NOTES" />

      <ControlRow label="Folder" htmlFor="settings-daily-folder">
        <input
          id="settings-daily-folder"
          type="text"
          placeholder="daily"
          aria-label="Daily notes folder"
          value={dailyFolder}
          onChange={(e) => setDailyFolder(e.target.value)}
          onBlur={() => {
            void handleDailyFolderCommit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleDailyFolderCommit();
          }}
          style={{ ...inputStyle, width: "100%" }}
        />
      </ControlRow>

      <div style={{ marginBottom: 8 }}>
        <label
          htmlFor="settings-daily-template"
          style={{ display: "block", fontSize: 14, color: "var(--color-fg)", marginBottom: 4 }}
        >
          Template
        </label>
        <textarea
          id="settings-daily-template"
          value={dailyTemplate}
          onChange={(e) => setDailyTemplate(e.target.value)}
          onBlur={() => {
            void handleDailyTemplateCommit();
          }}
          rows={4}
          spellCheck={false}
          aria-label="Daily note template"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            lineHeight: 1.5,
            background: "var(--color-bg)",
            color: "var(--color-fg)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            outline: "none",
            resize: "vertical",
          }}
        />
        <p style={{ fontSize: 12, color: "var(--color-muted)", margin: "4px 0", lineHeight: 1.5 }}>
          {`Use {{date}} to insert today's date (e.g. 2026-06-13).`}{" "}
          <button
            type="button"
            onClick={() => {
              void handleResetTemplateToDefault();
            }}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              color: "var(--color-accent)",
              textDecoration: "underline",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "inherit",
            }}
          >
            Reset to default
          </button>
        </p>
      </div>
    </section>
  );
}
