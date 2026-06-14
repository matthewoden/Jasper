/**
 * VaultPicker — vault selection modal with three tabs (Recent / Open existing / Create new).
 *
 * Two modes:
 *   - "boot": picker IS the page (no-vault state); Dialog is non-dismissable.
 *   - "switch": modal over MainShell; dismissable via Escape / outside-click.
 *
 * Banner from GET /vault/recent.banner is shown at the top when non-empty.
 * Missing entries render via VaultPickerRow with Reconnect/Remove affordances.
 */

import * as Dialog from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { useState } from "react";
import { useVaultPicker } from "../../lib/useVaultPicker";
import { VaultPickerRow } from "./VaultPickerRow";
import { VaultOpenPane } from "./VaultOpenPane";
import { VaultCreatePane } from "./VaultCreatePane";

type Tab = "recent" | "open" | "create";

export interface VaultPickerProps {
  mode: "boot" | "switch";
}

export function VaultPicker({ mode }: VaultPickerProps) {
  const { isOpen, close, recents, banner, refresh } = useVaultPicker();
  const [tab, setTab] = useState<Tab>(recents.length > 0 ? "recent" : "create");
  const [prefillPath, setPrefillPath] = useState("");

  const onReconnect = (path: string) => {
    setPrefillPath(path);
    setTab("open");
  };

  const open = mode === "boot" ? true : isOpen;
  const onOpenChange =
    mode === "boot"
      ? () => {
          /* non-dismissable in boot mode */
        }
      : (v: boolean) => {
          if (!v) close();
        };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal>
      <Dialog.Portal>
        <Dialog.Overlay className="vault-picker-overlay" />
        <Dialog.Content
          className="vault-picker-modal"
          aria-label="Vault picker"
        >
          <header className="vault-picker-header">
            <Dialog.Title>{mode === "switch" ? "Switch vault" : "Choose a vault"}</Dialog.Title>
            <Dialog.Description className="vault-picker-header__subtitle">
              {mode === "switch"
                ? "Open a different vault. Unsaved drafts are kept in the browser."
                : "Open an existing folder, pick a recent one, or create a new vault."}
            </Dialog.Description>
          </header>
          <VisuallyHidden.Root asChild>
            <span>Vault picker dialog</span>
          </VisuallyHidden.Root>

          {banner && (
            <div className="vault-picker-banner" role="alert">
              {banner}
            </div>
          )}

          <nav className="vault-picker-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "recent"}
              onClick={() => setTab("recent")}
            >
              Recent
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "open"}
              onClick={() => setTab("open")}
            >
              Open existing
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "create"}
              onClick={() => setTab("create")}
            >
              Create new
            </button>
          </nav>

          <div className="vault-picker-body">
            {tab === "recent" &&
              (recents.length === 0 ? (
                <div className="vault-picker-empty">
                  No recent vaults yet. Use <strong>Open existing</strong> to point
                  Jasper at a folder, or <strong>Create new</strong> to start fresh.
                </div>
              ) : (
                recents.map((e) => (
                  <VaultPickerRow
                    key={e.path}
                    entry={e}
                    onReconnect={onReconnect}
                    onForgotten={() => void refresh()}
                    mode={mode}
                  />
                ))
              ))}
            {tab === "open" && (
              <VaultOpenPane
                initialPath={prefillPath}
                onOpened={() => window.location.reload()}
              />
            )}
            {tab === "create" && (
              <VaultCreatePane onCreated={() => window.location.reload()} />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
