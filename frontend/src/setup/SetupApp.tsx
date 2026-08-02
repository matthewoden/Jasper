/**
 * SetupApp — single-page React root mounted at /setup.
 *
 * Composes the four section components over draft state and owns the submit pipeline.
 *
 * State flow:
 *   1. loadDraft() hydrates from localStorage on mount so mid-wizard reloads resume.
 *   2. Every field change calls updateDraft() → setState + saveDraft().
 *   3. DataDirSection calls onValidityChange to gate the submit button.
 *   4. Appearance step applies accent + reading font live (dark-only);
 *      useEffects on draft.accent/draft.readingFont keep the DOM in sync.
 *   5. On success: clearDraft() then window.location.assign("/") (reload IS the
 *      confirmation — no toast). On failure: surface the error message and re-enable.
 */

import { useEffect, useState } from "react";
import { loadDraft, saveDraft, clearDraft, type SetupDraft } from "./draft";
import { submitSetup, type SetupRequest } from "./setupApi";
import { applyAccent, applyReadingFont } from "../lib/useAccent";
import { DataDirSection } from "./sections/DataDirSection";
import { ThemeSection } from "./sections/ThemeSection";
import { DailyNoteSection } from "./sections/DailyNoteSection";

export function SetupApp() {
  const [draft, setDraft] = useState<SetupDraft>(() => loadDraft());
  const [isValid, setIsValid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Sync accent + reading font to DOM when draft loads from localStorage (resume flow).
  // ThemeSection also applies live on each selection; these effects handle the initial load.
  useEffect(() => {
    applyAccent(draft.accent);
  }, [draft.accent]);

  useEffect(() => {
    applyReadingFont(draft.readingFont);
  }, [draft.readingFont]);

  const updateDraft = (patch: Partial<SetupDraft>) => {
    setDraft((d) => {
      const next = { ...d, ...patch };
      saveDraft(next);
      return next;
    });
  };

  const canSubmit = isValid && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // theme is pinned to "dark"; the server still accepts the field for
      // wire compat. accent + readingFont are first-class optional fields on
      // SetupRequest — the backend persists them into config.json at vault
      // creation (firstrun.RunSetup → vault.CreateVault). The wizard no
      // longer seeds MCP grants — grants are managed post-setup via
      // the folder right-click menu.
      const payload: SetupRequest = {
        data_dir: draft.dataDir,
        theme: "dark",
        daily_template: draft.dailyTemplate,
        create_today_daily_note: draft.createTodayDailyNote,
        accent: draft.accent as SetupRequest["accent"],
        readingFont: draft.readingFont,
      };
      await submitSetup(payload);
      clearDraft();
      window.location.assign("/");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSubmitError(msg);
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        background: "var(--color-bg)",
        color: "var(--color-fg)",
        minHeight: "100vh",
        padding: "32px 32px",
      }}
    >
      <div style={{ maxWidth: 560, margin: "48px auto 0" }}>
        <h1
          style={{
            fontSize: 16,
            fontWeight: 600,
            lineHeight: 1.4,
            margin: 0,
            color: "var(--color-fg)",
          }}
        >
          Set up Jasper
        </h1>
        <p
          style={{
            fontSize: 14,
            color: "var(--color-muted)",
            margin: "8px 0 24px",
            lineHeight: 1.5,
          }}
        >
          A few choices and you&apos;re writing. You can change these later in
          config.json.
        </p>

        <DataDirSection
          value={draft.dataDir}
          onChange={(v) => updateDraft({ dataDir: v })}
          onValidityChange={setIsValid}
        />
        <ThemeSection
          accent={draft.accent}
          readingFont={draft.readingFont}
          onAccentChange={(a) => updateDraft({ accent: a })}
          onReadingFontChange={(rf) => updateDraft({ readingFont: rf })}
        />
        <DailyNoteSection
          template={draft.dailyTemplate}
          createToday={draft.createTodayDailyNote}
          onTemplateChange={(v) => updateDraft({ dailyTemplate: v })}
          onCreateTodayChange={(v) => updateDraft({ createTodayDailyNote: v })}
        />

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          aria-label="Start Jasper"
          style={{
            width: "100%",
            height: 44,
            marginTop: 24,
            background: "var(--color-accent)",
            color: "var(--color-bg)",
            fontWeight: 600,
            fontSize: 14,
            border: "none",
            borderRadius: 6,
            cursor: canSubmit ? "pointer" : "not-allowed",
            opacity: canSubmit ? 1 : 0.5,
          }}
        >
          {submitting ? "Setting up…" : "Start Jasper"}
        </button>

        {submitError && (
          <div
            role="alert"
            style={{
              color: "var(--color-destructive)",
              fontSize: 12,
              marginTop: 8,
              lineHeight: 1.5,
            }}
          >
            Couldn&apos;t finish setup: {submitError}. Check the log file and
            try again.
          </div>
        )}
      </div>
    </div>
  );
}
