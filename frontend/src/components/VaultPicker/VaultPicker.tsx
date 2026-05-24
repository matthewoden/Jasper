/**
 * VaultPicker — the vault selection modal.
 *
 * Three tabs: Recent / Open existing / Create new.
 * Two modes:
 *   - "boot": picker IS the page (no-vault state); Dialog is non-dismissable.
 *   - "switch": modal over MainShell; dismissable via Escape / outside-click.
 *
 * V13/V14: banner from GET /vault/recent.banner displayed at top when non-empty.
 * V11: missing entries rendered via VaultPickerRow with Reconnect/Remove affordances.
 *
 * Plan 08-17c Task 2.
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
  mode: "boot" | "switch"; // "boot" = picker IS the page; "switch" = modal over MainShell
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
          <Dialog.Title>Vault</Dialog.Title>
          <VisuallyHidden.Root asChild>
            <Dialog.Description>
              Select, open, or create a vault.
            </Dialog.Description>
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
              Open existing…
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "create"}
              onClick={() => setTab("create")}
            >
              Create new…
            </button>
          </nav>

          <div className="vault-picker-body">
            {tab === "recent" &&
              (recents.length === 0 ? (
                <p>No recent vaults. Create one or open an existing folder.</p>
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
