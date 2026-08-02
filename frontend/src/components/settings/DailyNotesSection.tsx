/**
 * DailyNotesSection — the Daily notes pane. Carries the template control
 * over verbatim; the mock's template picker/preview/"New note from
 * template" affordances belong to Templates, which does not exist yet. Its
 * folder-picking control was retired (UAT test 6, 2026-07-29): the config
 * field it wrote had zero functional consumers — daily-note creation
 * hardcodes "daily/".
 *
 * The inline "Reset to default" link was dropped (owner, 2026-07-30):
 * once the pane held a single control it duplicated the pane-header Reset,
 * which writes the identical patch via buildResetPatch's dailyNotes case.
 */
import { useCallback, useEffect, useState } from "react";
import { Eyebrow } from "./shared";
import type { SectionProps } from "./types";

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
          {`Use {{date}} to insert today's date (e.g. 2026-06-13).`}
        </p>
      </div>
    </section>
  );
}
