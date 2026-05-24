/**
 * FolderPicker — modal that lets the user browse the local filesystem and
 * select an absolute folder path without typing one.
 *
 * Renders inside a Radix Dialog so it overlays the parent VaultPicker (which
 * is itself a Dialog). The picker calls GET /api/v1/fs/list as the user
 * clicks into subfolders; the breadcrumb is reconstructed from the response's
 * canonical `path`.
 *
 * UAT-2 #1d follow-up. The OS-native folder picker isn't reachable from a
 * browser (privacy: no absolute paths exposed), so we build a server-side
 * directory enumerator and a browser-side click-through. Acceptable trade-off
 * because Jasper is loopback-only — the user already has shell access.
 */

import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { fsApi, type FsListResponse } from "../../lib/fsApi";

export interface FolderPickerProps {
  open: boolean;
  /** Path to start browsing from. Omit to default to the user's $HOME. */
  initialPath?: string;
  /** Called when the user clicks "Select this folder". Receives an absolute path. */
  onSelect: (path: string) => void;
  /** Called when the user dismisses the picker without selecting. */
  onCancel: () => void;
}

function breadcrumb(absPath: string): { label: string; path: string }[] {
  // Build [{label: "/", path:"/"}, {label: "Users", path: "/Users"}, ...] from
  // an absolute path. Empty input → just the root.
  if (!absPath || !absPath.startsWith("/")) return [{ label: "/", path: "/" }];
  const segments = absPath.split("/").filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let cur = "";
  for (const seg of segments) {
    cur += "/" + seg;
    crumbs.push({ label: seg, path: cur });
  }
  return crumbs;
}

export function FolderPicker({
  open,
  initialPath,
  onSelect,
  onCancel,
}: FolderPickerProps) {
  const [state, setState] = useState<FsListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fsApi.list(path);
      setState(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to list folder.";
      setError(msg);
      // Don't blow away `state` on error — the user can still navigate to
      // siblings via the breadcrumb.
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on open. We use `open` as the trigger so re-opening the picker
  // returns to the user's starting point (and refreshes the listing in case
  // they created folders in the OS between visits).
  useEffect(() => {
    if (!open) return;
    void load(initialPath);
  }, [open, initialPath, load]);

  const crumbs = state ? breadcrumb(state.path) : [];

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onCancel()} modal>
      <Dialog.Portal>
        <Dialog.Overlay className="vault-picker-overlay" style={{ zIndex: 60 }} />
        <Dialog.Content
          className="vault-picker-modal"
          aria-label="Folder picker"
          data-testid="folder-picker"
          style={{ zIndex: 61, width: 560, maxHeight: "70vh" }}
        >
          <header className="vault-picker-header">
            <Dialog.Title>Choose a folder</Dialog.Title>
            <Dialog.Description className="vault-picker-header__subtitle">
              Click into folders to navigate. Hidden folders are not shown.
            </Dialog.Description>
          </header>

          {/* Breadcrumb */}
          <nav
            aria-label="Folder breadcrumb"
            data-testid="folder-picker-breadcrumb"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 4,
              fontSize: 12,
              color: "var(--color-muted)",
              padding: "4px 0",
              borderBottom: "1px solid var(--color-border)",
            }}
          >
            {crumbs.map((c, i) => (
              <span key={c.path} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                {i > 0 && <span aria-hidden="true">›</span>}
                <button
                  type="button"
                  onClick={() => void load(c.path)}
                  style={{
                    appearance: "none",
                    background: "transparent",
                    border: "none",
                    color: i === crumbs.length - 1 ? "var(--color-fg)" : "var(--color-muted)",
                    cursor: "pointer",
                    padding: "2px 4px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                  }}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </nav>

          {/* Body — entries or status */}
          <div
            style={{
              flex: 1,
              minHeight: 240,
              overflowY: "auto",
              padding: "8px 0",
            }}
          >
            {loading && (
              <div className="vault-picker-empty" data-testid="folder-picker-loading">
                Loading…
              </div>
            )}
            {!loading && error && (
              <div className="vault-picker-error" role="alert" data-testid="folder-picker-error">
                {error}
              </div>
            )}
            {!loading && !error && state && state.entries.length === 0 && (
              <div className="vault-picker-empty">
                This folder has no subfolders. Click <strong>Select this folder</strong>{" "}
                to use it, or navigate back with the breadcrumb.
              </div>
            )}
            {!loading && !error && state && state.entries.length > 0 && (
              <ul
                role="list"
                data-testid="folder-picker-entries"
                style={{ listStyle: "none", padding: 0, margin: 0 }}
              >
                {state.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      data-testid={`folder-picker-entry-${entry.name}`}
                      onClick={() => void load(entry.path)}
                      style={{
                        appearance: "none",
                        background: "transparent",
                        border: "none",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 12px",
                        color: "var(--color-fg)",
                        fontSize: 14,
                        cursor: "pointer",
                        borderRadius: 4,
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.background =
                          "var(--color-surface-subtle)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                      }}
                    >
                      <span style={{ marginRight: 8 }} aria-hidden="true">
                        📁
                      </span>
                      {entry.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Footer — current path display + actions */}
          <footer
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              paddingTop: 12,
              borderTop: "1px solid var(--color-border)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: "var(--color-muted)",
                fontFamily: "var(--font-mono)",
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              data-testid="folder-picker-current-path"
              title={state?.path ?? ""}
            >
              {state?.path ?? "—"}
            </div>
            <button
              type="button"
              onClick={onCancel}
              style={{
                appearance: "none",
                background: "transparent",
                color: "var(--color-fg)",
                border: "1px solid var(--color-border)",
                borderRadius: 6,
                padding: "8px 14px",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="vault-picker-button-primary"
              data-testid="folder-picker-select"
              disabled={!state}
              onClick={() => state && onSelect(state.path)}
            >
              Select this folder
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
