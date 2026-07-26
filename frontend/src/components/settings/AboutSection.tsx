/**
 * AboutSection — the About pane. Read-only vault facts (SET3-04); no Reset
 * (D-08), no live grant editing (Phase 36 owns that surface). This is the
 * only pane that owns a network fetch of its own — gated on `visible`
 * (D-23), refetching on every reselect, never polling.
 */
import { Copy, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useReveal } from "../../lib/useReveal";
import { getVaultAbout, type VaultAbout } from "../../lib/vaultAboutApi";
import { useToast } from "../toast.utils";
import { Tooltip } from "../Tooltip";
import { Eyebrow } from "./shared";
import type { SectionProps } from "./types";

const iconButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  padding: 4,
  borderRadius: 4,
  display: "flex",
};

function AboutRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 24,
        padding: "16px 0",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 400, color: "var(--color-muted)" }}>{label}</span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 400,
          color: "var(--color-fg)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        {children}
      </span>
    </div>
  );
}

export function AboutSection({ visible }: SectionProps & { visible: boolean }) {
  const [data, setData] = useState<VaultAbout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const { revealVaultRoot } = useReveal();

  const fetchAbout = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getVaultAbout().then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.data) {
        setData(res.data);
      }
      if (res.error) {
        setError("Couldn't load vault details. Try again.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    return fetchAbout();
  }, [visible, fetchAbout]);

  const handleCopy = useCallback(async () => {
    if (!data) return;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard API unavailable");
      }
      await navigator.clipboard.writeText(data.path);
    } catch {
      toast({ title: "Could not copy vault path", variant: "error" });
    }
  }, [data, toast]);

  const value = (v: ReactNode) => (loading ? "—" : v);

  return (
    <section>
      <Eyebrow text="VAULT" />

      {error ? (
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
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={fetchAbout}
            style={{
              background: "transparent",
              border: "1px solid var(--color-warning)",
              borderRadius: 6,
              color: "var(--color-warning)",
              padding: "4px 12px",
              fontSize: 14,
              fontFamily: "inherit",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <AboutRow label="Vault name">{value(data?.vaultName ?? "—")}</AboutRow>
          <AboutRow label="Notes">{value(data ? String(data.noteCount) : "—")}</AboutRow>
          <AboutRow label="Folders">{value(data ? String(data.folderCount) : "—")}</AboutRow>
          <AboutRow label="Location">
            {loading || !data ? (
              "—"
            ) : (
              <>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  {data.path}
                </span>
                <Tooltip label="Copy vault path">
                  <button
                    type="button"
                    aria-label="Copy vault path"
                    onClick={() => {
                      void handleCopy();
                    }}
                    style={iconButtonStyle}
                  >
                    <Copy size={16} aria-hidden="true" />
                  </button>
                </Tooltip>
                <Tooltip label="Show in file manager">
                  <button
                    type="button"
                    aria-label="Show in file manager"
                    onClick={() => {
                      void revealVaultRoot();
                    }}
                    style={iconButtonStyle}
                  >
                    <FolderOpen size={16} aria-hidden="true" />
                  </button>
                </Tooltip>
              </>
            )}
          </AboutRow>
          <AboutRow label="App version">{value(data?.appVersion ?? "—")}</AboutRow>
          <AboutRow label="MCP">
            {value(data ? `Port ${data.mcpPort} · ${data.mcpGrantCount} writable path(s)` : "—")}
          </AboutRow>
        </>
      )}
    </section>
  );
}
