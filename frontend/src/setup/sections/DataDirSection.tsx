/**
 * DataDirSection — Section 1 of the first-run wizard.
 *
 * UI-SPEC §Surface 1 + §Copywriting Contract (LOCKED):
 *   eyebrow:        DATA DIRECTORY
 *   helper:         Where Jasper stores your notes and database. Pick an empty folder you already own.
 *   placeholder:    ~/Documents/Jasper
 *   aria-label:     Data directory path   ← 08-15 Playwright selector contract
 *
 * Behavior (D-08 + UI-SPEC §Surface 1 Pitfall 5):
 *   - 300ms debounce before calling POST /api/v1/setup/validate-data-dir
 *   - Monotonic request-id race guard: only the most recent in-flight
 *     response is allowed to mutate validity state.
 *   - AbortController cancels in-flight on new keystroke so the network
 *     pane shows at most one live validation request at a time
 *     (T-08-18 mitigation).
 *   - On invalid → 1px destructive border + 12px destructive helper
 *     text BELOW the input using the LOCKED message returned by the
 *     backend (one of the four D-08 strings).
 *   - On valid → lucide Check icon in the right gutter.
 *   - Pending → small gray spinner in the gutter.
 *
 * The section reports validity outward via `onValidityChange(boolean)`
 * so the SetupApp can enable/disable the primary "Start Jasper" button.
 *
 * Plan 08-04 Task 1.
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

  // Monotonic id so out-of-order responses can be discarded.
  const requestIdRef = useRef(0);
  // Latest AbortController so we can cancel on keystroke / unmount.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Empty input is the initial state — neither valid nor "invalid"
    // (we don't show the red border before the user has typed anything).
    if (value.trim().length === 0) {
      setStatus({ kind: "idle" });
      onValidityChange(false);
      // Cancel any in-flight validation if the user cleared the input.
      abortRef.current?.abort();
      return;
    }

    setStatus({ kind: "pending" });
    // Don't claim "valid" while a check is pending — caller should not
    // enable submit during this window.
    onValidityChange(false);

    const reqId = ++requestIdRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const timer = window.setTimeout(async () => {
      try {
        const resp = await validateDataDir(value, ac.signal);
        // Race guard: a newer keystroke may have superseded us.
        if (reqId !== requestIdRef.current) return;
        if (resp.valid) {
          setStatus({ kind: "valid" });
          onValidityChange(true);
        } else {
          setStatus({
            kind: "invalid",
            // LOCKED copy comes from the backend (UI-SPEC §Copywriting
            // Contract D-08a..d). Default to a generic refusal if the
            // backend somehow returns no message (defensive — should
            // not happen).
            message: resp.message ?? "Invalid path.",
          });
          onValidityChange(false);
        }
      } catch (err) {
        // Abort is expected when the user keeps typing. Anything else
        // is treated as a transient network failure — keep submit
        // disabled but don't render an invalid-style border, since the
        // user didn't enter anything actually invalid.
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
        DATA DIRECTORY
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

      {/* Keyframes for the pending spinner — inline so we don't pollute
          theme.css with a one-off animation. Phase 2 already uses the
          `jasper-progress-stripe` pattern in theme.css; this is a sibling. */}
      <style>{`
        @keyframes jasper-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </section>
  );
}
