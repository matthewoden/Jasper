/**
 * DataDirSection — data directory input for the first-run wizard.
 *
 * Debounces 300ms before calling POST /api/v1/setup/validate-data-dir.
 * Monotonic request-id + AbortController ensure only the most recent in-flight
 * response mutates state (rapid keystrokes cancel prior requests).
 *
 * Reports validity outward via onValidityChange(boolean) so SetupApp can
 * enable/disable the "Start Jasper" button.
 */

import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { validateDataDir } from "../setupApi";

interface DataDirSectionProps {
  value: string;
  onChange: (next: string) => void;
  /** Called whenever backend validation produces a definitive verdict. */
  onValidityChange: (valid: boolean) => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "valid" }
  | { kind: "invalid"; message: string };

const DEBOUNCE_MS = 300;

export function DataDirSection({
  value,
  onChange,
  onValidityChange,
}: DataDirSectionProps) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (value.trim().length === 0) {
      setStatus({ kind: "idle" });
      onValidityChange(false);
      abortRef.current?.abort();
      return;
    }

    setStatus({ kind: "pending" });
    onValidityChange(false);

    const reqId = ++requestIdRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const timer = window.setTimeout(async () => {
      try {
        const resp = await validateDataDir(value, ac.signal);
        if (reqId !== requestIdRef.current) return;
        if (resp.valid) {
          setStatus({ kind: "valid" });
          onValidityChange(true);
        } else {
          setStatus({
            kind: "invalid",
            message: resp.message ?? "Invalid path.",
          });
          onValidityChange(false);
        }
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "AbortError") return;
        if (reqId !== requestIdRef.current) return;
        setStatus({ kind: "idle" });
        onValidityChange(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [value, onValidityChange]);

  const invalid = status.kind === "invalid";

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
        DATA DIRECTORY · REQUIRED
      </div>
      <p
        style={{
          fontSize: 14,
          color: "var(--color-muted)",
          margin: "0 0 10px",
          lineHeight: 1.5,
        }}
      >
        Where Jasper stores your notes and database. Pick an empty folder you
        already own.
      </p>

      <div style={{ position: "relative" }}>
        <input
          type="text"
          aria-label="Data directory path"
          placeholder="~/Documents/Jasper"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          style={{
            width: "100%",
            height: 44,
            boxSizing: "border-box",
            padding: "0 36px 0 12px",
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            background: "var(--color-bg)",
            color: "var(--color-fg)",
            border: `1px solid ${
              invalid ? "var(--color-destructive)" : "var(--color-border)"
            }`,
            borderRadius: 6,
            outline: "none",
          }}
        />
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            right: 10,
            height: 44,
            width: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          {status.kind === "pending" && (
            <span
              role="status"
              aria-label="Checking path"
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                border: "2px solid var(--color-muted)",
                borderTopColor: "transparent",
                animation: "jasper-spin 0.8s linear infinite",
              }}
            />
          )}
          {status.kind === "valid" && (
            <Check size={16} color="var(--color-accent)" />
          )}
          {status.kind === "invalid" && (
            <X size={16} color="var(--color-destructive)" />
          )}
        </div>
      </div>

      {status.kind === "invalid" && (
        <div
          role="alert"
          style={{
            fontSize: 12,
            color: "var(--color-destructive)",
            marginTop: 6,
            lineHeight: 1.5,
          }}
        >
          {status.message}
        </div>
      )}

      {/* Keyframes inline to avoid polluting theme.css with a one-off animation. */}
      <style>{`
        @keyframes jasper-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </section>
  );
}
