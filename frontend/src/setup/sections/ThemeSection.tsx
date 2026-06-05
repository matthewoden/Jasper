/**
 * ThemeSection — Section 2 of the first-run wizard.
 *
 * UI-SPEC §Surface 1 + §Copywriting Contract (LOCKED):
 *   eyebrow: THEME
 *   helper:  You can switch any time. Wizard restyles live as you choose.
 *
 * Behavior (D-06 live-preview):
 *   - Two radio rows (Dark, Light).
 *   - Each <input type="radio"> carries aria-label="Dark" / aria-label="Light"
 *     (08-15 Playwright selector contract — DO NOT rename to "Dark theme").
 *   - Selecting a radio immediately calls onChange AND sets
 *     document.documentElement.setAttribute("data-theme", theme) so the
 *     wizard restyles live. SetupApp.tsx also keeps the attribute in sync
 *     via a useEffect on draft.theme, but the local write here avoids a
 *     render-cycle delay when the user clicks.
 *
 * Plan 08-04 Task 1.
 */

interface ThemeSectionProps {
  value: "dark" | "light";
  onChange: (next: "dark" | "light") => void;
}

function applyThemeNow(theme: "dark" | "light"): void {
  document.documentElement.setAttribute("data-theme", theme);
}

function ThemeRow({
  label,
  value,
  selected,
  onSelect,
}: {
  label: string;
  value: "dark" | "light";
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        height: 36,
        gap: 10,
        cursor: "pointer",
        fontSize: 14,
        color: "var(--color-fg)",
      }}
    >
      <input
        type="radio"
        name="setup-theme"
        value={value}
        checked={selected}
        onChange={onSelect}
        aria-label={label}
        style={{
          appearance: "none",
          margin: 0,
          width: 16,
          height: 16,
          borderRadius: "50%",
          border: `1px solid ${
            selected ? "var(--color-accent)" : "var(--color-border)"
          }`,
          background: "var(--color-bg)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          cursor: "pointer",
        }}
      />
      {selected && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--color-accent)",
            marginLeft: 4, // 16/2 - 8/2 = 4 inside the ring
            pointerEvents: "none",
          }}
        />
      )}
      <span>{label}</span>
    </label>
  );
}

export function ThemeSection({ value, onChange }: ThemeSectionProps) {
  const select = (next: "dark" | "light") => {
    applyThemeNow(next);
    onChange(next);
  };

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
        THEME
      </div>
      <p
        style={{
          fontSize: 14,
          color: "var(--color-muted)",
          margin: "0 0 10px",
          lineHeight: 1.5,
        }}
      >
        You can switch any time. Wizard restyles live as you choose.
      </p>

      <div style={{ position: "relative" }}>
        <ThemeRow
          label="Dark"
          value="dark"
          selected={value === "dark"}
          onSelect={() => select("dark")}
        />
        <ThemeRow
          label="Light"
          value="light"
          selected={value === "light"}
          onSelect={() => select("light")}
        />
      </div>
    </section>
  );
}
