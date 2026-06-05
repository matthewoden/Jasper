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


const FOLDER_NAME_OK = /^[A-Za-z0-9 _.()'-][A-Za-z0-9 _.()'-]*$/;

export interface FolderPickerProps {
  open: boolean;
  /** Path to start browsing from. Omit to default to the user's $HOME. */
  initialPath?: string;
  /** Called when the user clicks "Select this folder". Receives an absolute path. */
  onSelect: (path: string) => void;
  /** Called when the user dismisses the picker without selecting. */
  onCancel: () => void;
  /**
   * Optional. When set AND the picker navigates to a folder whose
   * is_vault flag is true (the backend stat'd a .jasper/ that isn't the
   * app registry), the footer swaps "Select this folder" for "Open Vault"
   * which calls this callback. Without this prop the picker still flips
   * to a "this is already a vault" banner but Select stays — the parent
   * (e.g. VaultOpenPane) just opens whatever path was selected.
   */
  onOpenVault?: (path: string) => void;
}

function breadcrumb(absPath: string): { label: string; path: string }[] {
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


function windowsBreadcrumb(
  wslPath: string,
  windowsPath: string,
): { label: string; path: string }[] | null {
  if (!windowsPath) return null;
  const wslMatch = wslPath.match(/^\/mnt\/([a-z])(\/.*)?$/);
  if (!wslMatch) return null;
  const drive = wslMatch[1];
  const winSegments = windowsPath.split("\\").filter(Boolean);
  if (winSegments.length === 0) return null;
  if (winSegments[0].toLowerCase() !== `${drive}:`) return null;

  const crumbs: { label: string; path: string }[] = [];
  crumbs.push({ label: `${winSegments[0].toUpperCase()}\\`, path: `/mnt/${drive}` });
  let cur = `/mnt/${drive}`;
  for (let i = 1; i < winSegments.length; i++) {
    cur += "/" + winSegments[i];
    crumbs.push({ label: winSegments[i], path: cur });
  }
  return crumbs;
}

export function FolderPicker({
  open,
  initialPath,
  onSelect,
  onCancel,
  onOpenVault,
}: FolderPickerProps) {
  const [state, setState] = useState<FsListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path?: string): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      const data = await fsApi.list(path);
      setState(data);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to list folder.";
      setError(msg);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const [editingPath, setEditingPath] = useState(false);
  const [editPath, setEditPath] = useState("");

  const enterPathEdit = () => {
    setEditPath(state?.path ?? "");
    setEditingPath(true);
  };

  const submitPathEdit = async () => {
    const ok = await load(editPath);
    if (ok) setEditingPath(false);
  };

  const cancelPathEdit = () => {
    setEditingPath(false);
    setError(null);
  };

  useEffect(() => {
    if (!open) {
      setEditingPath(false);
      setEditPath("");
      setNewFolderOpen(false);
      setNewFolderName("");
      setNewFolderErr(null);
    }
  }, [open]);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderErr, setNewFolderErr] = useState<string | null>(null);

  const submitNewFolder = async () => {
    if (!state) return;
    const name = newFolderName.trim();
    if (!name) {
      setNewFolderErr("Enter a name.");
      return;
    }
    if (!FOLDER_NAME_OK.test(name) || name.includes("..")) {
      setNewFolderErr("Use letters, digits, spaces, and . _ - ( ) ' only.");
      return;
    }
    setNewFolderErr(null);
    try {
      const created = await fsApi.mkdir(`${state.path}/${name}`);
      void created;
      setNewFolderOpen(false);
      setNewFolderName("");
      await load(state.path);
    } catch (e) {
      setNewFolderErr(e instanceof Error ? e.message : "Failed to create folder.");
    }
  };

  useEffect(() => {
    if (!open) return;
    void load(initialPath);
  }, [open, initialPath, load]);

  const crumbs = state
    ? (windowsBreadcrumb(state.path, state.windows_path ?? "") ?? breadcrumb(state.path))
    : [];

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

          {/* Breadcrumb (or typed-path input when editing) */}
          {editingPath ? (
            <div
              data-testid="folder-picker-breadcrumb-edit"
              style={{
                padding: "4px 0",
                borderBottom: "1px solid var(--color-border)",
              }}
            >
              <input
                type="text"
                className="vault-picker-input"
                value={editPath}
                onChange={(e) => setEditPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitPathEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelPathEdit();
                  }
                }}
                onBlur={cancelPathEdit}
                placeholder="/absolute/path/to/folder"
                aria-label="Type an absolute path"
                data-testid="folder-picker-path-input"
                autoFocus
                spellCheck={false}
                style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
              />
              <div
                style={{
                  fontSize: 11,
                  color: "var(--color-muted)",
                  marginTop: 4,
                }}
              >
                Enter to go there · Escape to cancel
              </div>
            </div>
          ) : (
            <nav
              aria-label="Folder breadcrumb"
              data-testid="folder-picker-breadcrumb"
              title="Double-click to type a path"
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest("button")) return;
                enterPathEdit();
              }}
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                fontSize: 12,
                color: "var(--color-muted)",
                padding: "4px 0",
                borderBottom: "1px solid var(--color-border)",
                cursor: "text",
                userSelect: "none",
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
          )}

          {/* Vault-detected banner — surfaces above the entries list when
              the current folder already contains a .jasper/ that isn't
              the app registry. The picker doesn't decide whether to open
              it; the footer's Open Vault button is what fires the action. */}
          {state?.is_vault === true && (
            <div
              className="vault-picker-banner"
              role="status"
              data-testid="folder-picker-vault-banner"
              style={{ marginTop: 4 }}
            >
              This folder is already a Jasper vault.
              {onOpenVault
                ? " Open it, or go up to choose a different folder."
                : " Select it to open."}
            </div>
          )}

          {/* New-folder affordance — either a button to start, or the
              inline name input. Keeps the user in the picker rather
              than punting them out to Finder to mkdir. */}
          {newFolderOpen ? (
            <div
              data-testid="folder-picker-new-folder-edit"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                paddingTop: 4,
              }}
            >
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  className="vault-picker-input"
                  data-testid="folder-picker-new-folder-input"
                  value={newFolderName}
                  onChange={(e) => {
                    setNewFolderName(e.target.value);
                    setNewFolderErr(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitNewFolder();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setNewFolderOpen(false);
                      setNewFolderName("");
                      setNewFolderErr(null);
                    }
                  }}
                  placeholder="New folder name"
                  aria-label="New folder name"
                  autoFocus
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="vault-picker-button-primary"
                  data-testid="folder-picker-new-folder-create"
                  onClick={() => void submitNewFolder()}
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNewFolderOpen(false);
                    setNewFolderName("");
                    setNewFolderErr(null);
                  }}
                  style={{
                    appearance: "none",
                    background: "transparent",
                    color: "var(--color-fg)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    padding: "8px 12px",
                    fontSize: 14,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
              {newFolderErr && (
                <div className="vault-picker-error" data-testid="folder-picker-new-folder-error">
                  {newFolderErr}
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 4 }}>
              <button
                type="button"
                data-testid="folder-picker-new-folder-button"
                disabled={!state}
                onClick={() => setNewFolderOpen(true)}
                style={{
                  appearance: "none",
                  background: "transparent",
                  color: "var(--color-fg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 6,
                  padding: "4px 10px",
                  fontSize: 12,
                  cursor: state ? "pointer" : "not-allowed",
                  opacity: state ? 1 : 0.5,
                }}
              >
                + New folder
              </button>
            </div>
          )}

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
              data-testid="folder-picker-current-path"
              title={state?.path ?? ""}
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: "var(--color-fg)",
                  fontFamily: "var(--font-mono)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                data-testid="folder-picker-current-path-primary"
              >
                {state?.windows_path || state?.path || "—"}
              </div>
              {state?.windows_path && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--color-muted)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  data-testid="folder-picker-current-path-secondary"
                  title="WSL path used by the backend"
                >
                  {state.path}
                </div>
              )}
            </div>
            {state?.is_vault === true && onOpenVault ? (
              <>
                <button
                  type="button"
                  data-testid="folder-picker-go-up"
                  onClick={() => state.parent && void load(state.parent)}
                  disabled={!state.parent}
                  style={{
                    appearance: "none",
                    background: "transparent",
                    color: "var(--color-fg)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    padding: "8px 14px",
                    fontSize: 14,
                    cursor: state.parent ? "pointer" : "not-allowed",
                    opacity: state.parent ? 1 : 0.5,
                  }}
                >
                  Go up
                </button>
                <button
                  type="button"
                  className="vault-picker-button-primary"
                  data-testid="folder-picker-open-vault"
                  onClick={() => state && onOpenVault(state.path)}
                >
                  Open Vault
                </button>
              </>
            ) : (
              <>
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
              </>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
