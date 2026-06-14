/**
 * SetupApp — single-page React root mounted at /setup.
 *
 * Composes the four section components over draft state and owns the submit pipeline.
 *
 * State flow:
 *   1. loadDraft() hydrates from localStorage on mount so mid-wizard reloads resume.
 *   2. Every field change calls updateDraft() → setState + saveDraft().
 *   3. DataDirSection calls onValidityChange to gate the submit button.
 *   4. Theme radio writes <html data-theme> synchronously for live preview;
 *      a useEffect on draft.theme also syncs it as a belt-and-braces fallback.
 *   5. On success: clearDraft() then window.location.assign("/") (reload IS the
 *      confirmation — no toast). On failure: surface the error message and re-enable.
 */

import { useEffect, useState } from "react";
import {
  loadDraft,
  saveDraft,
  clearDraft,
  type SetupDraft,
  type SetupGrantDraft,
} from "./draft";
import { submitSetup, type McpGrantSeed } from "./setupApi";


function dedupGrantsByFolder(grants: SetupGrantDraft[]): SetupGrantDraft[] {
  const map = new Map<string, SetupGrantDraft>();
  for (const g of grants) {
    const key = g.folder.trim().toLowerCase();
    if (key === "") continue;
    map.set(key, g);
  }
  return Array.from(map.values());
}
import { DataDirSection } from "./sections/DataDirSection";
import { ThemeSection } from "./sections/ThemeSection";
import { McpSection } from "./sections/McpSection";
import { DailyNoteSection } from "./sections/DailyNoteSection";

export function SetupApp() {
  const [draft, setDraft] = useState<SetupDraft>(() => loadDraft());
  const [isValid, setIsValid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", draft.theme);
  }, [draft.theme]);

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
      const grants: McpGrantSeed[] = dedupGrantsByFolder(draft.mcpGrants).map((g) => ({
        folder: g.folder.trim(),
        level: g.level,
      }));
      await submitSetup({
        data_dir: draft.dataDir,
        theme: draft.theme,
        mcp_enabled: draft.mcpEnabled,
        mcp_grants: grants,
        daily_template: draft.dailyTemplate,
        create_today_daily_note: draft.createTodayDailyNote,
      });
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
          value={draft.theme}
          onChange={(v) => updateDraft({ theme: v })}
        />
        <McpSection
          enabled={draft.mcpEnabled}
          grants={draft.mcpGrants}
          onEnabledChange={(v) => updateDraft({ mcpEnabled: v })}
          onGrantsChange={(g) => updateDraft({ mcpGrants: g })}
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
