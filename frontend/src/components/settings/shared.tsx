/**
 * Row primitives shared by every Settings section file (D-06). Extracted
 * verbatim from `SettingsDialog.tsx` — no logic or style changes, only the
 * `export` keyword and a one-level-deeper relative import path.
 */
import { AlertCircle } from "lucide-react";

// ─── Restart badge ─────────────────────────────────────────────────────────
// aria-label ensures screen readers announce it (not color only).
export function RestartBadge() {
  return (
    <span
      aria-label="Requires reload to apply"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 8px",
        height: 20,
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 600,
        color: "var(--color-warning)",
        background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
        whiteSpace: "nowrap",
        boxSizing: "border-box",
      }}
    >
      <AlertCircle size={12} aria-hidden="true" />
      Reload to apply
    </span>
  );
}

// ─── Shared input style ────────────────────────────────────────────────────
export const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  background: "var(--color-bg)",
  color: "var(--color-fg)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};

// ─── Section divider ───────────────────────────────────────────────────────
export function SectionDivider() {
  return (
    <hr
      style={{
        border: "none",
        borderTop: "1px solid var(--color-border)",
        margin: "24px 0",
      }}
    />
  );
}

// ─── Section eyebrow ──────────────────────────────────────────────────────
export function Eyebrow({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: "var(--color-muted)",
        letterSpacing: 0.4,
        textTransform: "uppercase",
        marginBottom: 8,
      }}
    >
      {text}
    </div>
  );
}

// ─── Control label row ────────────────────────────────────────────────────
export function ControlRow({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 16,
        marginBottom: 8,
      }}
    >
      <label
        htmlFor={htmlFor}
        style={{
          fontSize: 14,
          color: "var(--color-fg)",
          minWidth: 160,
          paddingTop: 8,
          flexShrink: 0,
        }}
      >
        {label}
      </label>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
