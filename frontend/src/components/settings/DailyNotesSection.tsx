/**
 * DailyNotesSection — the Daily notes pane. Carries the template control
 * over verbatim; the mock's template picker/preview/"New note from
 * template" affordances are Phase 35 work (Templates don't exist yet). Its
 * folder-picking control was retired (UAT test 6, 2026-07-29): the config
 * field it wrote had zero functional consumers — daily-note creation
 * hardcodes "daily/".
 */
import { useCallback, useEffect, useState } from "react";
import { Eyebrow } from "./shared";
import type { SectionProps } from "./types";

const DEFAULT_TEMPLATE = "# {{date}}\n\n";

export function DailyNotesSection({ config, saveConfig, onSaveError }: SectionProps) {
  const [dailyTemplate, setDailyTemplate] = useState(() => config.dailyNotes.template);

  useEffect(() => {
    setDailyTemplate(config.dailyNotes.template);
  }, [config.dailyNotes.template]);

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
