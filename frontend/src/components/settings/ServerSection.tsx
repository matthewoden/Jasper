/**
 * ServerSection — the Server pane. Ships the bind address alone (D-02); the
 * MCP port field, audit-log toggle, and write-grant picker are all Phase 36
 * work. Named "Server" rather than the mock's MCP-only framing because the
 * bind address is a server-level concern, not an MCP-specific one.
 */
import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ControlRow, Eyebrow, inputStyle, RestartBadge } from "./shared";
import type { SectionProps } from "./types";

export interface ServerSectionProps extends SectionProps {
  showBindBadge: boolean;
}

export function ServerSection({ config, saveConfig, onSaveError, showBindBadge }: ServerSectionProps) {
  const [bindAddress, setBindAddress] = useState(() => config.server?.bind ?? "127.0.0.1");

  useEffect(() => {
    setBindAddress(config.server?.bind ?? "127.0.0.1");
  }, [config.server?.bind]);

  const handleBindAddressCommit = useCallback(async () => {
    if (!config.server) return;
    const { error } = await saveConfig({
      ...config,
      server: { ...config.server, bind: bindAddress },
    });
    if (error) {
      onSaveError(error.message);
    } else {
      onSaveError(null);
    }
  }, [config, bindAddress, saveConfig, onSaveError]);

  return (
    <section>
      <Eyebrow text="SERVER" />

      <ControlRow label="Bind address" htmlFor="settings-bind-address">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            id="settings-bind-address"
            type="text"
            placeholder="127.0.0.1"
            aria-label="Bind address"
            aria-describedby="settings-bind-helper"
            value={bindAddress}
            onChange={(e) => setBindAddress(e.target.value)}
            onBlur={() => {
              void handleBindAddressCommit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleBindAddressCommit();
            }}
            style={{ ...inputStyle, width: "100%", fontFamily: "var(--font-mono)" }}
          />
          {showBindBadge && <RestartBadge />}
        </div>
        <span
          id="settings-bind-helper"
          style={{ fontSize: 12, color: "var(--color-muted)", display: "block", marginTop: 4 }}
        >
          Loopback only (127.0.0.1) or all interfaces (0.0.0.0).
        </span>
        <span style={{ fontSize: 12, color: "var(--color-muted)", display: "block", marginTop: 2 }}>
          Requires a server restart to take effect.
        </span>
      </ControlRow>

      {/* Beyond-loopback warning — driven by the PERSISTED config value, not
          local input state, so a half-typed address never flashes it. */}
      {config.server?.bind &&
        config.server.bind !== "127.0.0.1" &&
        config.server.bind !== "localhost" &&
        config.server.bind !== "::1" && (
          <div
            role="alert"
            style={{
              padding: "8px 12px",
              background: "var(--color-warning-surface)",
              border: "1px solid var(--color-warning)",
              borderRadius: 6,
              color: "var(--color-warning)",
              fontSize: 14,
              lineHeight: 1.4,
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              marginTop: 8,
            }}
          >
            <AlertCircle size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
            <span>
              Jasper is exposed on all network interfaces. Only enable LAN access on trusted networks.
            </span>
          </div>
        )}
    </section>
  );
}

// Not shipped this phase (D-17 fields; Phase 36 owns the rest of the Server
// story): mcp.port, mcp.auditLog, and the write-grant folder picker.
