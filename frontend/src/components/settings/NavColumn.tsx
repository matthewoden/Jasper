/**
 * NavColumn — the 216px fixed left nav (D-19 locked geometry). Renders
 * `SECTIONS` (never a hardcoded list — Phase 35 adds Templates and Phase 36
 * adds Server back by editing the manifest alone).
 */
import { SECTIONS, type SectionId } from "./sections";

export interface NavColumnProps {
  activeSection: SectionId;
  onSelect: (id: SectionId) => void;
  vaultName?: string;
  appVersion?: string;
}

export function NavColumn({ activeSection, onSelect, vaultName, appVersion }: NavColumnProps) {
  const footerText =
    vaultName && appVersion
      ? `${vaultName} · v${appVersion}`
      : (vaultName ?? (appVersion ? `v${appVersion}` : ""));

  return (
    <div
      style={{
        width: 216,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--color-surface)",
        borderRight: "1px solid var(--color-border)",
        minHeight: 0,
      }}
    >
      <div
        style={{
          height: 56,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--color-fg-title)" }}>
          Settings
        </span>
      </div>

      <nav
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "8px 0",
        }}
      >
        {SECTIONS.map((section) => {
          const active = section.id === activeSection;
          return (
            <button
              key={section.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onSelect(section.id)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                // Inert with a single child (the leading label group). Kept
                // for the trailing slot ADR-002 v2 emptied when the Server
                // restart dot was removed 2026-07-26, and that Phase 36's
                // restart signal will refill. Delete both if it does not.
                justifyContent: "space-between",
                gap: 8,
                padding: "8px 16px",
                background: active
                  ? "color-mix(in srgb, var(--color-accent) 14%, transparent)"
                  : "transparent",
                border: "none",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: active ? "var(--color-accent)" : "transparent",
                  }}
                />
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: active ? 600 : 400,
                    color: active ? "var(--color-fg-title)" : "var(--color-muted)",
                  }}
                >
                  {section.label}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      {footerText && (
        <div
          style={{
            flexShrink: 0,
            padding: "8px 16px 16px",
            fontSize: 12,
            fontWeight: 400,
            color: "var(--color-muted)",
          }}
        >
          {footerText}
        </div>
      )}
    </div>
  );
}
