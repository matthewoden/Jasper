/**
 * Migration Error Banner — renders when state === "rolled_back".
 *
 * Banner is server-state-driven: Dismiss only hides it for the current browser
 * session; the server still has the rolled-back schema, so a page reload re-shows it.
 */

import { AlertTriangle } from "lucide-react";
import { useState } from "react";

import type { UseMigrationStatusResult } from "../lib/useMigrationStatus";
import { useToast } from "./toast.utils";

interface Props {
  onResetConfirm: () => void;
  status: UseMigrationStatusResult;
}

export function MigrationBanner({ onResetConfirm, status }: Props) {
  const { toast } = useToast();
  const [dismissed, setDismissed] = useState(false);

  if (status.state !== "rolled_back" || dismissed) return null;

  const filename = status.failedMigration ?? "(unknown)";
  const logsPath = status.logsPath ?? "";

  const onCopyLogsPath = async () => {
    try {
      await navigator.clipboard.writeText(logsPath);
    } catch {
      // Clipboard API may be unavailable in non-secure contexts; toast still confirms intent.
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
        borderLeft: "4px solid var(--color-warning)",
        borderBottom: "1px solid var(--color-border)",
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
