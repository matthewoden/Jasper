/**
 * TreeRowMenu — two trigger variants sharing the same content body:
 *   - TreeRowContextMenu: Radix ContextMenu (right-click)
 *   - TreeRowDropdownMenu: Radix DropdownMenu (kebab click)
 *
 * MenuItems branches on rowKind; Item / Separator differ per primitive so they
 * are passed as ItemComp / SepComp props.
 *
 * Item set (locked):
 *   note       → Open · Open in split · sep · New note · sep · Bookmark
 *                (Remove bookmark) · sep · Rename(F2) · Delete(⌫)
 *   folder     → New note · New folder · sep · Rename(F2) · Delete(⌫)
 *   empty-area → New note · New folder
 *   file       → Rename(F2) · Delete(⌫)  (files can't host children; click opens preview)
 *   bookmark   → Remove (destructive) · Move to folder (submenu: (No folder) ·
 *                existing folders · sep · New folder…) — NEVER rename, MCP-grant,
 *                reveal, or delete-note (quick task 260719-jv1, item 5).
 *
 * Bulk variant (CTX-02): when `selectionCount` (a prop independent of
 * rowKind) is > 1, MenuItems renders a COMPLETELY different body — Open
 * ({N} tabs) · Open in split · sep · Bookmark {N} notes · sep · Delete
 * {N} notes — and every single-target item above is hidden entirely (not
 * disabled). Callers read the live selection at menu-open time (not
 * row-render time — see TreeRow.tsx's onOpenChange wiring) so a stale
 * selectionCount never leaks into an already-open menu.
 */
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Bookmark,
  BookmarkCheck,
  FolderOpen,
  SplitSquareHorizontal,
  Sparkles,
} from "lucide-react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";

export type TreeRowMenuKind = "note" | "folder" | "empty-area" | "file" | "bookmark";

export interface TreeRowMenuProps {
  rowKind: TreeRowMenuKind;
  /** present iff rowKind === "note" */
  noteId?: string;
  /** path used for New note / New folder targets */
  parentPath: string;
  onOpen?: () => void;
  onNewNote: () => void;
  /** present iff rowKind !== "note" */
  onNewFolder?: () => void;
  /** not on empty-area */
  onRename?: () => void;
  /** not on empty-area */
  onDelete?: () => void;
  /**
   * "Show in file manager" reveal action. Present on note/folder/file rows;
   * omitted on empty-area (no path).
   *   - note rows  → below "Open", before first separator
   *   - folder rows → below "New folder", before AI-grant submenu slot
   *   - file rows  → top of menu (files: Reveal + Rename + Delete only)
   */
  onReveal?: () => void;

  /**
   * MCP "Grant AI access" submenu — folder rows only.
   *   - activeLevel: DIRECT grant at this folder (1/2/null). Ancestor grants
   *     don't surface here; use directLevelFor, not levelFor.
   *   - onGrant(level): "Edit only" (1) or "Full" (2). Idempotent.
   *   - onRevoke(): "Revoke access". Only shown when activeLevel !== null.
   * Omitted on note/file/empty-area rows.
   */
  activeLevel?: 1 | 2 | null;
  onGrant?: (level: 1 | 2) => void;
  onRevoke?: () => void;

  /**
   * Inherited grant from an ANCESTOR folder. When non-null and activeLevel
   * is null (no direct grant here), replaces the "Grant AI access ▸" submenu
   * with a DISABLED "Inherits AI access from <ancestor>" label — prevents
   * a redundant grant on a child already covered by the ancestor (recursive
   * coverage). When the row has its own direct grant, the Sub still renders so
   * Revoke is reachable. Omitted on note/file/empty-area rows.
   */
  inheritedGrant?: InheritedGrant | null;

  /**
   * Bookmark-row menu data (rowKind === "bookmark" only). folders lists
   * every bookmark folder for the "Move to folder" submenu; the submenu
   * always leads with "(No folder)" (top-level) and ends with
   * "New folder…" below a separator — mirrors the pre-existing bespoke
   * BookmarkRow menu verbatim, just hosted on the
   * shared TreeRowMenu chrome now.
   */
  bookmarkFolders?: Array<{ id: string; name: string }>;
  onRemoveBookmark?: () => void;
  onMoveBookmarkToFolder?: (folderId: string | null) => void;
  onNewBookmarkFolder?: () => void;

  /** note rows only: single right/row split, same target as the
   *  quick-switcher's Cmd+Shift+Enter and the note-options split-right item. */
  onOpenInSplit?: () => void;
  /** note rows only: true when bookmarked anywhere (root or any folder) —
   *  drives the "Bookmark" / "Remove bookmark" label + icon. */
  isBookmarked?: boolean;
  /** note rows only: toggles the bookmark (always adds to the bookmarks
   *  root when turning on — no folder-picker submenu here). */
  onToggleBookmark?: () => void;

  /**
   * Bulk-selection variant. When set to a number > 1, MenuItems
   * renders ONLY the bulk item set below, ignoring rowKind entirely.
   * Meaningless (omit or leave <= 1) outside a multi-select right-click.
   */
  selectionCount?: number;
  /** Bulk: opens all N selected notes as tabs in the active pane. */
  onBulkOpenTabs?: () => void;
  /** Bulk: opens ONE new split pane containing all N selected notes as tabs. */
  onBulkOpenInSplit?: () => void;
  /** Bulk: adds all N selected notes to the bookmarks root (skips
   *  already-bookmarked, toasts the outcome). */
  onBulkBookmark?: () => void;
  /** Bulk: opens the shared delete-confirm dialog with bulk copy. */
  onBulkDelete?: () => void;
}

/**
 * Mirrors useMcpGrants.InheritedGrant — duplicated to avoid an import cycle
 * if menus are ever built inside the hook.
 */
export interface InheritedGrant {
  level: 1 | 2;
  ancestorPath: string;
}

/** Tier label — locked copy. */
function tierLabel(level: 1 | 2): string {
  return level === 2 ? "Full Access" : "Edit only";
}

/** Basename helper: last path segment, or "vault root" for empty paths. */
function basenameOf(path: string): string {
  if (path === "" || path === ".") return "vault root";
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}


const menuContainerStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  paddingTop: 4,
  paddingBottom: 4,
  minWidth: 200,
  maxWidth: 320,
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
  zIndex: 50,
};

const itemStyle: CSSProperties = {
  height: 32,
  display: "flex",
  alignItems: "center",
  padding: "0 16px",
  gap: 8,
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-fg)",
  cursor: "pointer",
  outline: "none",
  userSelect: "none",
};

const destructiveItemStyle: CSSProperties = {
  ...itemStyle,
  color: "var(--color-destructive)",
};

const shortcutStyle: CSSProperties = {
  marginLeft: "auto",
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-muted)",
};

const separatorStyle: CSSProperties = {
  height: 1,
  background: "var(--color-border)",
  margin: "4px 0",
  border: "none",
};


type ItemCompType =
  | typeof ContextMenu.Item
  | typeof DropdownMenu.Item;
type SepCompType =
  | typeof ContextMenu.Separator
  | typeof DropdownMenu.Separator;


type SubCompType =
  | typeof ContextMenu.Sub
  | typeof DropdownMenu.Sub;
type SubTriggerCompType =
  | typeof ContextMenu.SubTrigger
  | typeof DropdownMenu.SubTrigger;
type SubContentCompType =
  | typeof ContextMenu.SubContent
  | typeof DropdownMenu.SubContent;
type PortalCompType =
  | typeof ContextMenu.Portal
  | typeof DropdownMenu.Portal;

interface MenuItemsProps extends TreeRowMenuProps {
  ItemComp: ItemCompType;
  SepComp: SepCompType;
  SubComp: SubCompType;
  SubTriggerComp: SubTriggerCompType;
  SubContentComp: SubContentCompType;
  PortalComp: PortalCompType;
}

function MenuItems({
  rowKind,
  onOpen,
  onNewNote,
  onNewFolder,
  onRename,
  onDelete,
  onReveal,
  activeLevel,
  onGrant,
  onRevoke,
  inheritedGrant,
  bookmarkFolders,
  onRemoveBookmark,
  onMoveBookmarkToFolder,
  onNewBookmarkFolder,
  onOpenInSplit,
  isBookmarked,
  onToggleBookmark,
  selectionCount,
  onBulkOpenTabs,
  onBulkOpenInSplit,
  onBulkBookmark,
  onBulkDelete,
  ItemComp,
  SepComp,
  SubComp,
  SubTriggerComp,
  SubContentComp,
  PortalComp,
}: MenuItemsProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Item = ItemComp as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sep = SepComp as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sub = SubComp as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SubTrigger = SubTriggerComp as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SubContent = SubContentComp as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Portal = PortalComp as any;

  const isFile = rowKind === "file";
  const isBookmark = rowKind === "bookmark";

  const revealLabel = "Show in file manager";
  const revealAria =
    rowKind === "note"
      ? "Show note in file manager"
      : rowKind === "folder"
        ? "Show folder in file manager"
        : "Show file in file manager";
  const revealItem =
    rowKind !== "empty-area" && rowKind !== "bookmark" && onReveal ? (
      <Item style={itemStyle} aria-label={revealAria} onSelect={() => onReveal()}>
        <FolderOpen size={16} aria-hidden="true" />
        <span>{revealLabel}</span>
      </Item>
    ) : null;

  if (selectionCount !== undefined && selectionCount > 1) {
    // Bulk-selection variant — completely replaces the rowKind-
    // specific body; single-target items (Rename, Show in file manager)
    // are hidden entirely, not disabled.
    //
    // event.stopPropagation() is required on BOTH onClick and onSelect here
    // (bulkItemHandlers below) — this is stronger than the pre-existing
    // "New note"/"New folder" defense (onSelect only),
    // because that defense turned out to be insufficient in a real browser
    // for THIS interaction: Radix's onSelect fires from an internal
    // custom-event dispatch, not the originating click, so calling
    // stopPropagation() only there does not stop the real click's SEPARATE
    // React-synthetic bubble path. Radix composes any consumer-supplied
    // onClick with its own internal click handling (consumer's onClick
    // runs first), so stopping propagation THERE reliably prevents the
    // click from reaching react-arborist's DefaultRow wrapper one level up
    // (`onClick={node.handleClick}` → `node.select()`), which would
    // otherwise collapse the live multi-selection down to just the row the
    // context menu was opened on — silently truncating every bulk action
    // to N=1 between menu-open and the actual mutation. Verified against
    // the real-browser regression this fixes, not just JSDOM.
    const bulkItemHandlers = (
      onSelectHandler?: () => void,
    ): { onClick: (e: MouseEvent) => void; onSelect: (e: Event) => void } => ({
      onClick: (e: MouseEvent) => e.stopPropagation(),
      onSelect: (e: Event) => {
        e.stopPropagation();
        onSelectHandler?.();
      },
    });
    return (
      <>
        <Item style={itemStyle} {...bulkItemHandlers(onBulkOpenTabs)}>
          <span>Open ({selectionCount} tabs)</span>
        </Item>
        <Item style={itemStyle} {...bulkItemHandlers(onBulkOpenInSplit)}>
          <SplitSquareHorizontal size={16} aria-hidden="true" />
          <span>Open in split</span>
        </Item>
        <Sep style={separatorStyle} />
        <Item style={itemStyle} {...bulkItemHandlers(onBulkBookmark)}>
          <Bookmark size={16} aria-hidden="true" />
          <span>Bookmark {selectionCount} notes</span>
        </Item>
        <Sep style={separatorStyle} />
        <Item style={destructiveItemStyle} {...bulkItemHandlers(onBulkDelete)}>
          <span>Delete {selectionCount} notes</span>
        </Item>
      </>
    );
  }

  if (isBookmark) {
    // Bookmark rows: Remove / Move to folder (submenu) ONLY — never rename,
    // MCP-grant, reveal, or delete-note (locked item set, see file header).
    const folders = bookmarkFolders ?? [];
    return (
      <>
        <Item style={destructiveItemStyle} onSelect={() => onRemoveBookmark?.()}>
          <span>Remove</span>
        </Item>
        <Sub>
          <SubTrigger style={itemStyle}>
            <span>Move to folder</span>
          </SubTrigger>
          <Portal>
            <SubContent style={menuContainerStyle}>
              <Item style={itemStyle} onSelect={() => onMoveBookmarkToFolder?.(null)}>
                <span>(No folder)</span>
              </Item>
              {folders.length > 0 && <Sep style={separatorStyle} />}
              {folders.map((f) => (
                <Item
                  key={f.id}
                  style={itemStyle}
                  onSelect={() => onMoveBookmarkToFolder?.(f.id)}
                >
                  <span>{f.name}</span>
                </Item>
              ))}
              <Sep style={separatorStyle} />
              <Item style={itemStyle} onSelect={() => onNewBookmarkFolder?.()}>
                <span>New folder…</span>
              </Item>
            </SubContent>
          </Portal>
        </Sub>
      </>
    );
  }

  return (
    <>
      {rowKind === "note" && (
        <Item style={itemStyle} onSelect={() => onOpen?.()}>
          <span>Open</span>
        </Item>
      )}
      {/* Note rows: Open in split, below "Open". stopPropagation
          mirrors the same defense (see bulk-variant comment
          above) — harmless here (single-target select+activate would be a
          no-op re-select of the same row) but kept consistent. */}
      {rowKind === "note" && onOpenInSplit && (
        <Item
          style={itemStyle}
          onSelect={(event: Event) => {
            event.stopPropagation();
            onOpenInSplit();
          }}
        >
          <SplitSquareHorizontal size={16} aria-hidden="true" />
          <span>Open in split</span>
        </Item>
      )}
      {/* Note rows: Reveal below "Open in split", before first separator. */}
      {rowKind === "note" && revealItem}
      {rowKind === "note" && <Sep style={separatorStyle} />}
      {/* File rows: Reveal at top, before Rename + Delete. */}
      {isFile && revealItem}
      {!isFile && (
        <Item
          style={itemStyle}
          onSelect={(event: Event) => {
            event.stopPropagation();
            onNewNote();
          }}
        >
          <span>New note</span>
        </Item>
      )}
      {/* Note rows: Bookmark toggle, below "New note" (always adds to
          the bookmarks root; no folder-picker submenu here). */}
      {rowKind === "note" && onToggleBookmark && (
        <>
          <Sep style={separatorStyle} />
          <Item
            style={itemStyle}
            onSelect={(event: Event) => {
              event.stopPropagation();
              onToggleBookmark();
            }}
          >
            {isBookmarked ? (
              <BookmarkCheck size={16} aria-hidden="true" />
            ) : (
              <Bookmark size={16} aria-hidden="true" />
            )}
            <span>{isBookmarked ? "Remove bookmark" : "Bookmark"}</span>
          </Item>
        </>
      )}
      {rowKind !== "note" && !isFile && (
        <Item
          style={itemStyle}
          onSelect={(event: Event) => {
            event.stopPropagation();
            onNewFolder?.();
          }}
        >
          <span>New folder</span>
        </Item>
      )}
      {/* Folder rows: Reveal below "New folder", before AI-grant submenu. */}
      {rowKind === "folder" && revealItem}
      {/* Inherited grant: ancestor covers this folder, so show a DISABLED label
          rather than a submenu (creating a redundant grant is ambiguous). */}
      {rowKind === "folder" && inheritedGrant && !activeLevel && (
        <Item
          style={{ ...itemStyle, opacity: 0.6, cursor: "not-allowed" }}
          disabled
          onSelect={(e: Event) => {
            e.preventDefault();
          }}
          data-inherited-grant="true"
        >
          <Sparkles
            size={14}
            aria-hidden="true"
            style={{
              color:
                inheritedGrant.level === 2
                  ? "var(--color-ai-grant-strong)"
                  : "var(--color-ai-grant)",
              flexShrink: 0,
            }}
          />
          <span>
            Inherits AI access from {basenameOf(inheritedGrant.ancestorPath)} ({tierLabel(inheritedGrant.level)})
          </span>
        </Item>
      )}
      {/* "Grant AI access ▸" submenu — folder rows only.
          Suppressed when an inherited grant exists and there's no direct grant
          (disabled label above takes over). When a direct grant exists, "Revoke
          access" appears below a separator. */}
      {rowKind === "folder" &&
        (onGrant || onRevoke) &&
        !(inheritedGrant && !activeLevel) && (
        <Sub key={`sub-${activeLevel ?? "none"}`}>
          <SubTrigger style={itemStyle}>
            <span>Grant AI access</span>
            {/* Sparkles icon next to SubTrigger when folder has an active grant.
                Color tier: violet-400 for Tier 1, violet-600 for Tier 2. */}
            {activeLevel && (
              <>
                <Sparkles
                  size={14}
                  aria-hidden="true"
                  style={{
                    marginLeft: "auto",
                    color:
                      activeLevel === 2
                        ? "var(--color-ai-grant-strong)"
                        : "var(--color-ai-grant)",
                    flexShrink: 0,
                  }}
                />
                <span style={{ ...shortcutStyle, marginLeft: 4 }}>
                  {activeLevel === 1 ? "Edit only" : "Full"}
                </span>
              </>
            )}
          </SubTrigger>
          <Portal>
            <SubContent style={menuContainerStyle}>
              {/* data-active drives theme.css active-item rule — stronger tint,
                  left stripe, bold weight (distinguishable from hover at same accent-12%). */}
              <Item
                data-active={activeLevel === 1 ? "true" : undefined}
                style={{ ...itemStyle, height: 36 }}
                onSelect={() => onGrant?.(1)}
              >
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 14 }}>Edit only</span>
                  <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
                    Create + update
                    {activeLevel === 1 ? " — Active" : ""}
                  </span>
                </div>
              </Item>
              <Item
                data-active={activeLevel === 2 ? "true" : undefined}
                style={{ ...itemStyle, height: 36 }}
                onSelect={() => onGrant?.(2)}
              >
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 14 }}>Full</span>
                  <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
                    Create + update + move + delete
                    {activeLevel === 2 ? " — Active" : ""}
                  </span>
                </div>
              </Item>
              {activeLevel && onRevoke && (
                <>
                  <Sep style={separatorStyle} />
                  <Item
                    style={destructiveItemStyle}
                    onSelect={() => onRevoke()}
                  >
                    <span>Revoke access</span>
                  </Item>
                </>
              )}
            </SubContent>
          </Portal>
        </Sub>
      )}
      {rowKind !== "empty-area" && !isFile && <Sep style={separatorStyle} />}
      {rowKind !== "empty-area" && (
        <Item style={itemStyle} onSelect={() => onRename?.()}>
          <span>Rename</span>
          <span style={shortcutStyle}>F2</span>
        </Item>
      )}
      {rowKind !== "empty-area" && (
        <Item style={destructiveItemStyle} onSelect={() => onDelete?.()}>
          <span>Delete</span>
          <span style={shortcutStyle}>⌫</span>
        </Item>
      )}
    </>
  );
}


export function TreeRowContextMenu({
  children,
  onOpenChange,
  ...props
}: TreeRowMenuProps & {
  children: ReactNode;
  /**
   * Forwarded from Radix ContextMenu.Root so callers can observe open-state
   * transitions. The Sub block is keyed on activeLevel inside MenuItems to
   * guarantee SubContent unmount+remount when grants change.
   */
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <ContextMenu.Root onOpenChange={onOpenChange}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content style={menuContainerStyle}>
          <MenuItems
            {...props}
            ItemComp={ContextMenu.Item}
            SepComp={ContextMenu.Separator}
            SubComp={ContextMenu.Sub}
            SubTriggerComp={ContextMenu.SubTrigger}
            SubContentComp={ContextMenu.SubContent}
            PortalComp={ContextMenu.Portal}
          />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function TreeRowDropdownMenu({
  children,
  open,
  onOpenChange,
  ...props
}: TreeRowMenuProps & {
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        {/* side=right align=start keeps the source row visible; default bottom/end
            drops the menu over the narrow sidebar row. */}
        <DropdownMenu.Content
          style={menuContainerStyle}
          side="right"
          align="start"
          sideOffset={4}
        >
          <MenuItems
            {...props}
            ItemComp={DropdownMenu.Item}
            SepComp={DropdownMenu.Separator}
            SubComp={DropdownMenu.Sub}
            SubTriggerComp={DropdownMenu.SubTrigger}
            SubContentComp={DropdownMenu.SubContent}
            PortalComp={DropdownMenu.Portal}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
