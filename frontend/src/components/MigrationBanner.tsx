/**
 * Surface 1 — Migration Error Banner. UI-SPEC §Surface 1 locks every
 * visual + copy detail; this component implements that contract verbatim.
 *
 * Renders nothing when state !== "rolled_back". Banner is server-state-
 * driven, NOT user-state-driven — Dismiss only hides it for the current
 * browser session; the server still has the rolled-back schema, so a
 * page reload re-shows it.
 *
 * Phase 4 will replace useMigrationStatus()'s internals with a WebSocket
 * subscription; this component must not change.
 */

import { AlertTriangle } from "lucide-react";
import { useState } from "react";

import { useMigrationStatus } from "../lib/useMigrationStatus";
import { useToast } from "./Toast";

interface Props {
  onResetConfirm: () => void;
}

export function MigrationBanner({ onResetConfirm }: Props) {
  const status = useMigrationStatus();
  const { toast } = useToast();
  const [dismissed, setDismissed] = useState(false);

  if (status.state !== "rolled_back" || dismissed) return null;

  // Locked copy template per UI-SPEC §Surface 1. The headline is
  // `Migration {filename} failed.` — `{filename}` is the spec's literal
  // template marker; it is replaced at render time with the concrete
  // failed_migration value (or `(unknown)` if absent).
  const filename = status.failedMigration ?? "(unknown)";
  const logsPath = status.logsPath ?? "";

  const onCopyLogsPath = async () => {
    try {
      await navigator.clipboard.writeText(logsPath);
    } catch {
      // Clipboard API may be unavailable in non-secure contexts; the
      // toast still confirms the user's intent. Native install (Phase 8)
      // will replace this with a "Show in Finder" action that doesn't
      // depend on the clipboard at all.
    }
    toast({
      title: "Log path copied to clipboard.",
      durationMs: 3000,
    });
  };

  return (
    <div
      role="alert"
      aria-live="polite"
      className="bg-warning-surface flex items-start w-full"
      style={{
        // Locked spec: 4px left border --color-warning, 1px bottom border
        // --color-border (continuous with the sidebar/editor divider).
        borderLeft: "4px solid var(--color-warning)",
        borderBottom: "1px solid var(--color-border)",
        // 16px (md) horizontal padding, 12px vertical (--spacing-md-tight).
        paddingTop: "var(--spacing-md-tight)",
        paddingBottom: "var(--spacing-md-tight)",
        paddingLeft: 16,
        paddingRight: 16,
        gap: 16,
      }}
    >
      <AlertTriangle
        size={20}
        aria-hidden="true"
        style={{
          color: "var(--color-warning)",
          flexShrink: 0,
          marginTop: 2,
        }}
      />
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--color-warning)",
          }}
        >
          {/* Locked copy: Migration {filename} failed. */}
          Migration {filename} failed.
        </div>
        <div style={{ fontSize: 14, color: "var(--color-fg)" }}>
          Your notes are safe — the previous schema was restored.
        </div>
        <div style={{ fontSize: 14, color: "var(--color-muted)" }}>
          View logs:{" "}
          <button
            type="button"
            onClick={onCopyLogsPath}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: "var(--color-muted)",
              fontSize: 14,
              fontFamily: "inherit",
              textDecoration: "none",
            }}
            // Hover effect (underline + accent) is handled inline via
            // onMouseEnter/Leave to avoid leaking these styles into the
            // global CSS — the banner is the only "warning surface" use site.
            onMouseEnter={(e) => {
              e.currentTarget.style.textDecoration = "underline";
              e.currentTarget.style.color = "var(--color-accent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.textDecoration = "none";
              e.currentTarget.style.color = "var(--color-muted)";
            }}
          >
            {logsPath}
          </button>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          marginLeft: "auto",
          alignItems: "flex-start",
        }}
      >
        <button
          type="button"
          onClick={onResetConfirm}
          style={{
            height: 32,
            padding: "0 12px",
            border: "1px solid var(--color-accent)",
            color: "var(--color-accent)",
            background: "transparent",
            borderRadius: 4,
            fontSize: 14,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          Reset and rebuild database
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          style={{
            height: 32,
            padding: "0 12px",
            border: "none",
            color: "var(--color-muted)",
            background: "transparent",
            borderRadius: 4,
            fontSize: 14,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
