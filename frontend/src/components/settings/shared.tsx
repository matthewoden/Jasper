/**
 * Row primitives shared by every Settings section file (D-06). Originally
 * lifted from `SettingsDialog.tsx`; `ControlRow` has since been restructured
 * (fixed 160px label column + optional description slot) so the two are no
 * longer identical.
 *
 * ControlRow's left column is deliberately `width: 160`, not `minWidth: 160`
 * — a growing caption must not widen the column and desynchronise the
 * slider tracks beside it (G-02). Guarded by shared.test.tsx and by the
 * slider-width parity assertion in e2e/phase32-uat.spec.ts.
 */
import { AlertCircle } from "lucide-react";

// ─── Restart badge ─────────────────────────────────────────────────────────
// aria-label ensures screen readers announce it (not color only).
//
// ORPHANED 2026-07-26 (ADR-002 v2): ServerSection was its only consumer and
// was removed with the Server pane. Kept — not deleted — because Phase 36's
// mcp.port control needs the same restart-signal primitive. If Phase 36
// lands without adopting it, delete this and the AlertCircle import above.
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
// The id ControlRow gives its description element. Consumers pass this to
// their control's aria-describedby rather than hardcoding the suffix.
export function controlDescriptionId(htmlFor: string) {
  return `${htmlFor}-desc`;
}

export function ControlRow({
  label,
  htmlFor,
  description,
  children,
}: {
  label: string;
  htmlFor?: string;
  description?: string;
  children: React.ReactNode;
}) {
  const labelStyle: React.CSSProperties = {
    fontSize: 14,
    color: "var(--color-fg)",
  };

  // Captions carry the real validator bounds ("8–32px"), so they must be
  // announced when focus lands on the control, not discovered by tripping
  // validation. Consumers point their control's aria-describedby at
  // `${htmlFor}-desc` (see `describedById`).
  const descId = htmlFor && description ? controlDescriptionId(htmlFor) : undefined;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 16,
        marginBottom: 8,
      }}
    >
      <div style={{ width: 160, paddingTop: 8, flexShrink: 0 }}>
        {htmlFor ? (
          <label htmlFor={htmlFor} style={labelStyle}>
            {label}
          </label>
        ) : (
          <div style={labelStyle}>{label}</div>
        )}
        {description && (
          <div
            id={descId}
            style={{
              fontSize: 12,
              color: "var(--color-muted)",
              marginTop: 2,
              lineHeight: 1.45,
            }}
          >
            {description}
          </div>
        )}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
