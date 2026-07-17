/**
 * MCP Unavailable Banner — renders when the backend reports the MCP
 * listener (port 6684) failed to bind (mcp.up === false).
 *
 * Banner is server-state-driven: Dismiss only hides it for the current
 * browser session; if MCP is still down on next reload/boot, the server
 * reports up=false again and the banner reappears (D-05). Informational
 * only — no remediation action (see `jasper doctor` for a fix hint).
 */

import { AlertTriangle } from "lucide-react";
import { useState } from "react";

import type { UseMigrationStatusResult } from "../lib/useMigrationStatus";

interface Props {
  status: UseMigrationStatusResult;
}

export function McpUnavailableBanner({ status }: Props) {
  const [dismissed, setDismissed] = useState(false);

  if (status.mcp?.up !== false || dismissed) return null;

  const reason = status.mcp.reason;
  const body = reason
    ? `${reason} — AI read/write tools are disabled this session.`
    : "Port 6684 in use — AI read/write tools are disabled this session.";

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
          AI tools unavailable
        </div>
        <div style={{ fontSize: 14, color: "var(--color-fg)" }}>{body}</div>
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
