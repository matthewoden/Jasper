/**
 * DailyNoteSection — Section 4 of the first-run wizard.
 *
 * Copywriting (LOCKED):
 *   eyebrow:        DAILY NOTES
 *   helper:         Each day gets a fresh note at notes/daily/YYYY-MM-DD.md.
 *                   Customize the starter template here.
 *   textarea label: Template
 *   checkbox label: Create today's daily note now
 */

interface DailyNoteSectionProps {
  template: string;
  createToday: boolean;
  onTemplateChange: (next: string) => void;
  onCreateTodayChange: (next: boolean) => void;
}

export function DailyNoteSection({
  template,
  createToday,
  onTemplateChange,
  onCreateTodayChange,
}: DailyNoteSectionProps) {
  return (
    <section style={{ marginBottom: 24 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--color-muted)",
          letterSpacing: 0.4,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        DAILY NOTES
      </div>
      <p
        style={{
          fontSize: 14,
          color: "var(--color-muted)",
          margin: "0 0 10px",
          lineHeight: 1.5,
        }}
      >
        Each day gets a fresh note at notes/daily/YYYY-MM-DD.md. Customize the
        starter template here.
      </p>

      <p style={{ fontSize: 12, color: "var(--color-muted)", margin: "0 0 8px", lineHeight: 1.5 }}>
        Use <code style={{ fontFamily: "var(--font-mono)" }}>{"{{date}}"}</code> to insert today&apos;s date (e.g. 2026-05-19). It&apos;s the only supported token — everything else is inserted unchanged.{" "}
        <button
          type="button"
          onClick={() => onTemplateChange("# {{date}}\n\n")}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            color: "var(--color-accent)",
            textDecoration: "underline",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Insert example
        </button>
      </p>

      <label
        htmlFor="setup-daily-template"
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--color-muted)",
          marginBottom: 4,
        }}
      >
        Template
      </label>
      <textarea
        id="setup-daily-template"
        value={template}
        onChange={(e) => onTemplateChange(e.target.value)}
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

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 10,
          fontSize: 14,
          color: "var(--color-fg)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={createToday}
          onChange={(e) => onCreateTodayChange(e.target.checked)}
          aria-label="Create today's daily note now"
        />
        <span>Create today's daily note now</span>
      </label>
    </section>
  );
}
