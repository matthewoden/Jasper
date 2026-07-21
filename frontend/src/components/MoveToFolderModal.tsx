/**
 * MoveToFolderModal — fuzzy folder picker (D-23), fully replacing the
 * mockup's `window.prompt` implementation.
 *
 * Reuses CommandMenu.tsx's Dialog shell SHAPE (overlay, centered card, 44px
 * input header, list body, footer hint row) — not a copy-paste fork, this
 * is a smaller, self-contained component: narrower card (480px vs.
 * 600-620px), single-line folder-path rows instead of two-line note
 * previews, and a plain (non-virtualized) list, since a vault's folder
 * count is small relative to its note count (UI-SPEC §6 explicitly
 * allows a plain list here).
 *
 * Fuzzy matching mirrors useQuickSwitcher.ts's fuzzysort.go options
 * (key/limit/threshold) for matching-feel consistency across the app.
 */
import * as Dialog from "@radix-ui/react-dialog";
import fuzzysort from "fuzzysort";
import { Folder } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";

import { useFileTree, walkTreeCollect } from "../lib/useFileTree";
import { useTreeMutations } from "../lib/useTreeMutations";
import { KeyboardChip } from "./KeyboardChip";
import { useToast } from "./toast.utils";

export interface MoveToFolderModalProps {
  noteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const VAULT_ROOT_LABEL = "Vault root";
const VAULT_ROOT_KEY = "__vault_root__";

interface FolderCandidate {
  /** "" for the vault root. */
  path: string;
  label: string;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.5)",
};

const contentStyle: CSSProperties = {
  position: "fixed",
  top: "12vh",
  left: "50%",
  transform: "translateX(-50%)",
  width: 480,
  maxWidth: "calc(100vw - 48px)",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 12,
  overflow: "hidden",
};

const inputRowStyle: CSSProperties = {
  height: 44,
  padding: "0 16px",
  borderBottom: "1px solid var(--color-border)",
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const inputStyle: CSSProperties = {
  flex: 1,
  background: "transparent",
  border: "none",
  outline: "none",
  color: "var(--color-fg)",
  fontSize: 14,
  fontFamily: "inherit",
};

const listStyle: CSSProperties = {
  maxHeight: "50vh",
  overflowY: "auto",
};

const emptyStateStyle: CSSProperties = {
  padding: "48px 16px",
  textAlign: "center",
  color: "var(--color-muted)",
  fontSize: 14,
};

const footerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  padding: "8px 16px",
  borderTop: "1px solid var(--color-border)",
  background: "var(--color-surface-raised)",
};

function rowStyle(selected: boolean): CSSProperties {
  return {
    height: 36,
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 16px",
    fontSize: 14,
    fontWeight: 400,
    color: "var(--color-fg)",
    cursor: "pointer",
    background: selected
      ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
      : "transparent",
  };
}

export function MoveToFolderModal({ noteId, open, onOpenChange }: MoveToFolderModalProps) {
  const { tree } = useFileTree();
  const { moveNote } = useTreeMutations();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
    }
  }, [open]);

  const candidates = useMemo<FolderCandidate[]>(() => {
    const folders = tree
      ? Array.from(walkTreeCollect(tree).folders).sort((a, b) => a.localeCompare(b))
      : [];
    return [
      { path: "", label: VAULT_ROOT_LABEL },
      ...folders.map((f) => ({ path: f, label: f })),
    ];
  }, [tree]);

  const items = useMemo<FolderCandidate[]>(() => {
    if (query.trim() === "") return candidates;
    const results = fuzzysort.go(query, candidates, {
      key: "label",
      limit: 50,
      threshold: -10000,
    });
    return results.map((r) => r.obj);
  }, [query, candidates]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  const handleMove = async (targetPath: string) => {
    try {
      await moveNote(noteId, targetPath);
      onOpenChange(false);
    } catch {
      toast({ title: "Couldn't move note. Try again.", variant: "error" });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = items[selectedIdx];
      if (item) void handleMove(item.path);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay style={overlayStyle} />
        <Dialog.Content
          aria-describedby={undefined}
          style={contentStyle}
          onKeyDown={onKeyDown}
        >
          <Dialog.Title style={{ display: "none" }}>Move to folder</Dialog.Title>
          <div style={inputRowStyle}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Move to folder…"
              aria-label="Move to folder"
              autoFocus
              style={inputStyle}
            />
          </div>
          <div style={listStyle}>
            {items.length === 0 ? (
              <div style={emptyStateStyle} role="status">
                No matching folders
              </div>
            ) : (
              items.map((item, i) => {
                const selected = i === selectedIdx;
                return (
                  <div
                    key={item.path === "" ? VAULT_ROOT_KEY : item.path}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setSelectedIdx(i)}
                    onClick={() => void handleMove(item.path)}
                    style={rowStyle(selected)}
                  >
                    <Folder
                      size={16}
                      aria-hidden="true"
                      style={{ color: "var(--color-muted)", flexShrink: 0 }}
                    />
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.label}
                    </span>
                  </div>
                );
              })
            )}
          </div>
          <div style={footerStyle}>
            {[
              { glyph: "↑↓", label: "navigate" },
              { glyph: "↵", label: "move" },
              { glyph: "esc", label: "dismiss" },
            ].map(({ glyph, label }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <KeyboardChip>{glyph}</KeyboardChip>
                <span style={{ fontSize: 12, color: "var(--color-muted)" }}>{label}</span>
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
