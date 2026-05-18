/**
 * McpSection — Section 3 of the first-run wizard.
 *
 * UI-SPEC §Surface 1 + §Copywriting Contract (LOCKED):
 *   eyebrow:      AI ACCESS (MCP)
 *   helper:       Optional. Lets local AI tools read your notes — and, in
 *                 folders you pick, write to them. Off by default.
 *   checkbox:     Enable MCP server for AI tools
 *   grants hint:  Pick folders where AI can create and edit notes. You can
 *                 change this later from any folder's right-click menu.
 *   empty state:  No folders granted yet. (Reads are global once MCP is on.)
 *   add button:   Add folder…
 *
 * Behavior:
 *   - v1 uses window.prompt for folder selection (08-PATTERNS.md §"No Analog
 *     Found"). Acknowledged rough edge — flagged in the plan's must_haves
 *     and surfaced in the plan summary, not silently deferred. Future plan
 *     replaces with a folder picker.
 *   - Client-side path validation (Phase 8 Warning #7) — `isValidGrantFolderPath`
 *     rejects: empty/whitespace, `..` traversal, leading `/` (POSIX absolute),
 *     `<letter>:[/\]` (Windows drive-letter absolute), and any non-ASCII chars.
 *     Backend re-validates at submit time (T-08-06 mitigation) — the client
 *     validation here is UX, not security.
 *   - Invalid input → inline error message under the grants list (NOT alert());
 *     auto-clears after 4 seconds.
 *
 * Plan 08-04 Task 1.
 */

import { useEffect, useRef, useState } from "react";
import type { SetupGrantDraft } from "../draft";

/**
 * Phase 8 Warning #7 client-side validation. Backend re-validates (T-08-06).
 *
 * Exported so McpSection.test.tsx (and any future shared use) can drive
 * the validator as a pure function. The grep gate in 08-04 done-criteria
 * checks for the function name + each of the rejection patterns below.
 */
export function isValidGrantFolderPath(p: string): boolean {
  const trimmed = p.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("..")) return false;
  if (trimmed.startsWith("/")) return false;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return false;
  if (/[^\x20-\x7E]/.test(trimmed)) return false;
  return true;
}

interface McpSectionProps {
  enabled: boolean;
  grants: SetupGrantDraft[];
  onEnabledChange: (next: boolean) => void;
  onGrantsChange: (next: SetupGrantDraft[]) => void;
}

const SECTION_EYEBROW_STYLE = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-muted)",
  letterSpacing: 0.4,
  textTransform: "uppercase" as const,
  marginBottom: 6,
};

const HELPER_STYLE = {
  fontSize: 14,
  color: "var(--color-muted)",
  margin: "0 0 10px",
  lineHeight: 1.5,
};

export function McpSection({
  enabled,
  grants,
  onEnabledChange,
  onGrantsChange,
}: McpSectionProps) {
  const [error, setError] = useState<string | null>(null);
  const errorTimerRef = useRef<number | null>(null);

  // Clear any pending auto-clear timer when this component unmounts so we
  // don't call setState on an unmounted React node.
  useEffect(() => {
    return () => {
      if (errorTimerRef.current !== null) {
        window.clearTimeout(errorTimerRef.current);
      }
    };
  }, []);

  const flashError = (message: string) => {
    setError(message);
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
    }
    errorTimerRef.current = window.setTimeout(() => {
      setError(null);
      errorTimerRef.current = null;
    }, 4000);
  };

  const handleAddFolder = () => {
    // v1 implementation per 08-PATTERNS.md §"No Analog Found" — no folder
    // picker primitive exists in-repo yet. The wizard surfaces this as a
    // known rough edge; v2 replaces with a native picker.
    const raw = window.prompt("Folder path under notes/:");
    // `null` = user pressed Cancel; do nothing (no error message — the
    // user explicitly bailed out).
    if (raw === null) return;
    if (!isValidGrantFolderPath(raw)) {
      flashError(
        'Invalid folder path. Use a path relative to notes/ (e.g. "projects" or "scratch/2026").',
      );
      return;
    }
    // Default new grants to Tier 1 (Edit only) per D-19.
    const next: SetupGrantDraft = { folder: raw.trim(), level: 1 };
    onGrantsChange([...grants, next]);
  };

  const handleRemoveGrant = (index: number) => {
    onGrantsChange(grants.filter((_, i) => i !== index));
  };

  const handleChangeLevel = (index: number, level: 1 | 2) => {
    onGrantsChange(grants.map((g, i) => (i === index ? { ...g, level } : g)));
  };

  return (
    <section style={{ marginBottom: 24 }}>
      <div style={SECTION_EYEBROW_STYLE}>AI ACCESS (MCP)</div>
      <p style={HELPER_STYLE}>
        Optional. Lets local AI tools read your notes — and, in folders you
        pick, write to them. Off by default.
      </p>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 14,
          color: "var(--color-fg)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
          aria-label="Enable MCP server for AI tools"
        />
        <span>Enable MCP server for AI tools</span>
      </label>

      {enabled && (
        <div style={{ marginTop: 12 }}>
          <p style={{ ...HELPER_STYLE, margin: "0 0 8px" }}>
            Pick folders where AI can create and edit notes. You can change this
            later from any folder's right-click menu.
          </p>

          {grants.length === 0 ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--color-muted)",
                fontStyle: "italic",
                margin: "6px 0",
              }}
            >
              No folders granted yet. (Reads are global once MCP is on.)
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
              {grants.map((g, idx) => (
                <li
                  key={`${g.folder}-${idx}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    height: 32,
                    fontSize: 13,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-fg)",
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {g.folder}
                  </span>
                  <select
                    value={g.level}
                    aria-label={`Access level for ${g.folder}`}
                    onChange={(e) =>
                      handleChangeLevel(
                        idx,
                        Number(e.target.value) === 2 ? 2 : 1,
                      )
                    }
                    style={{
                      fontSize: 12,
                      background:
                        g.level === 2
                          ? "var(--color-ai-grant-strong)"
                          : "var(--color-ai-grant)",
                      color: "var(--color-bg)",
                      border: "none",
                      borderRadius: 999,
                      padding: "2px 8px",
                      fontWeight: 600,
                    }}
                  >
                    <option value={1}>Tier 1</option>
                    <option value={2}>Tier 2</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => handleRemoveGrant(idx)}
                    aria-label={`Remove ${g.folder}`}
                    style={{
                      background: "transparent",
                      color: "var(--color-muted)",
                      border: "none",
                      cursor: "pointer",
                      fontSize: 14,
                      padding: "2px 6px",
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && (
            <div
              role="alert"
              style={{
                fontSize: 12,
                color: "var(--color-destructive)",
                margin: "6px 0",
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleAddFolder}
            style={{
              background: "transparent",
              color: "var(--color-accent)",
              border: `1px dashed var(--color-border)`,
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 13,
              cursor: "pointer",
              marginTop: 4,
            }}
          >
            Add folder…
          </button>
        </div>
      )}
    </section>
  );
}
