/**
 * ThemeSection — theme picker for the first-run wizard (Dark / Light).
 *
 * aria-label values are "Dark" and "Light" (not "Dark theme") — Playwright
 * selectors depend on the exact string.
 *
 * Selecting a radio immediately writes data-theme to <html> for live preview.
 * SetupApp also syncs it via useEffect on draft.theme; the local write here
 * avoids the render-cycle delay on click.
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
            marginLeft: 4, // center the 8px dot inside the 16px ring
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
