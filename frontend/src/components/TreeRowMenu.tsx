/**
 * TreeRowMenu — UI-SPEC §Surface 2.
 *
 * Exports two trigger variants that share the SAME content body:
 *   - <TreeRowContextMenu> wraps Radix ContextMenu (right-click)
 *   - <TreeRowDropdownMenu> wraps Radix DropdownMenu (kebab click)
 *
 * Both render an internal <MenuItems /> body whose item set branches on
 * rowKind. The Item / Separator components differ between the two
 * primitives, so MenuItems takes them as ItemComp / SepComp props.
 *
 * Visual specification is locked in UI-SPEC §Surface 2:
 *   - Container: bg-surface, 1px border-border, radius 6, padding xs
 *     vertical, min-width 200, max-width 320, soft shadow.
 *   - Item: 32px tall, padding 0 16, gap 8, fontSize 14, hover bg
 *     rgba(255,255,255,0.04). Destructive item uses text-destructive
 *     with a destructive-tinted hover background.
 *   - Shortcut: right-aligned text-muted (F2 / ⌫).
 *
 * Item set table (locked verbatim):
 *   note         → Open · sep · New note · sep · Rename(F2) · Delete(⌫)
 *   folder       →                 New note · New folder · sep · Rename(F2) · Delete(⌫)
 *   empty-area   →                 New note · New folder
 *   file         →                 Rename(F2) · Delete(⌫)    (Plan 07-38 R7b)
 *
 * Plan 07-38 R7b: file-kind rows are non-markdown attachments / generic
 * files surfaced in the sidebar tree (FileNodeData in TreeRow.tsx). They
 * have no "Open" because clicking the row opens the preview view; they
 * have no "New note" / "New folder" because files cannot host children.
 * Rename + Delete dispatch through filesApi.moveFile / deleteFile in
 * FileTree.handleCommitRename / handleConfirmDelete.
 */
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { FolderOpen, Sparkles } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

export type TreeRowMenuKind = "note" | "folder" | "empty-area" | "file";

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
   * Plan 08-06 (D-26 / SHARE-01): "Show in file manager" reveal action.
   *
   * Present on note / folder / file rows; omitted on empty-area (no path).
   * The caller is expected to wire this through useReveal().reveal(path)
   * with the correct path for the row kind:
   *   - note   → note path (e.g. "projects/jasper/note.md")
   *   - folder → folder path (e.g. "projects/jasper")
   *   - file   → file path (e.g. "attachments/diagram.png")
   *
   * Position in the menu body is locked by UI-SPEC §Surface 4 Mount A:
   *   - note rows  → directly below "Open", before the first separator
   *   - folder rows → directly below "New folder", before the AI-grant
   *                   submenu mount-slot (filled by Plan 08-10)
   *   - file rows  → at the TOP of the menu (becomes the new first item)
   */
  onReveal?: () => void;

  /**
   * Plan 08-10 (D-17, D-19, MCP-01): MCP "Grant AI access" submenu — folder rows only.
   *
   *   - activeLevel: the DIRECT grant attached to this folder (1 / 2 / null).
   *                  Null means no grant attached AT THIS leaf (ancestor
   *                  grants don't surface here per UI-SPEC §Surface 3 —
   *                  use directLevelFor, not levelFor).
   *   - onGrant(level): user clicked "Edit only" (1) or "Full" (2).
   *                     Idempotent — backend re-validates.
   *   - onRevoke(): user clicked "Revoke access". Only shown when
   *                 activeLevel !== null.
   *
   * Omitted on note / file / empty-area rows.
   */
  activeLevel?: 1 | 2 | null;
  onGrant?: (level: 1 | 2) => void;
  onRevoke?: () => void;

  /**
   * R4-9 (Plan 08-22): inherited grant on an ANCESTOR folder. When
   * non-null AND `activeLevel` is null (no direct grant on this leaf),
   * the "Grant AI access ▸" SubTrigger is replaced by a single DISABLED
   * menu item reading `Inherits AI access from <basename(ancestorPath)>
   * (<tierLabel(level)>)`. This prevents the user from creating a
   * redundant grant on a child whose ancestor already covers it (D-18
   * recursive coverage).
   *
   * If the row holds its own direct grant (`activeLevel != null`), the
   * existing Sub still renders so Revoke is reachable.
   *
   * Omitted on note / file / empty-area rows (no MCP submenu there).
   */
  inheritedGrant?: InheritedGrant | null;
}

/**
 * Mirrors useMcpGrants.InheritedGrant — duplicated here so the menu
 * component doesn't have to import from the hook (avoids a cycle when
 * future code paths build menus inside the hook for previews).
 */
export interface InheritedGrant {
  level: 1 | 2;
  ancestorPath: string;
}

/** Tier label per UI-SPEC §Surface 2 — locked copy. */
function tierLabel(level: 1 | 2): string {
  return level === 2 ? "Full Access" : "Edit only";
}

/** Basename helper: last path segment, or "vault root" for empty paths. */
function basenameOf(path: string): string {
  if (path === "" || path === ".") return "vault root";
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

// ────────────────────────────────────────────────────────────────────
// Locked styles (UI-SPEC §Surface 2)
// ────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────
// Shared item body
// ────────────────────────────────────────────────────────────────────

type ItemCompType =
  | typeof ContextMenu.Item
  | typeof DropdownMenu.Item;
type SepCompType =
  | typeof ContextMenu.Separator
  | typeof DropdownMenu.Separator;

// Plan 08-10: parallel family for the Radix Sub primitives so MenuItems can
// emit the "Grant AI access ▸" submenu against either ContextMenu.* or
// DropdownMenu.* without branching at the call site. Each variant carries
// its own portal / subtrigger / subcontent.
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
  // Plan 08-10 — parallel sub family; one set per primitive variant.
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
  ItemComp,
  SepComp,
  SubComp,
  SubTriggerComp,
  SubContentComp,
  PortalComp,
}: MenuItemsProps) {
  // Cast each Radix Item/Separator to a permissive type so we can hand
  // them inline `style` props uniformly. Both ContextMenu.Item and
  // DropdownMenu.Item accept `onSelect`, `style`, and `children` — the
  // shared props we use here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Item = ItemComp as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sep = SepComp as any;
  // Plan 08-10 — same permissive cast for the Sub family.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sub = SubComp as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SubTrigger = SubTriggerComp as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SubContent = SubContentComp as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Portal = PortalComp as any;

  // Plan 07-38 R7b: file rows render ONLY Rename + Delete — no Open,
  // no New note, no New folder. Files can't host children, and clicking
  // the row already opens the preview view (no "Open" menu entry needed).
  const isFile = rowKind === "file";

  // Plan 08-06 (D-26 / SHARE-01): "Show in file manager" item appears on
  // note / folder / file rows; never on empty-area (no path to reveal).
  // The aria-label varies per row kind so screen readers announce the
  // verb-noun verbatim from UI-SPEC §Copywriting "4 mount points" table.
  const revealLabel = "Show in file manager";
  const revealAria =
    rowKind === "note"
      ? "Show note in file manager"
      : rowKind === "folder"
        ? "Show folder in file manager"
        : "Show file in file manager"; // file
  const revealItem =
    rowKind !== "empty-area" && onReveal ? (
      <Item style={itemStyle} aria-label={revealAria} onSelect={() => onReveal()}>
        <FolderOpen size={16} aria-hidden="true" />
        <span>{revealLabel}</span>
      </Item>
    ) : null;

  return (
    <>
      {rowKind === "note" && (
        <Item style={itemStyle} onSelect={() => onOpen?.()}>
          <span>Open</span>
        </Item>
      )}
      {/* Plan 08-06 Mount A — note rows: Reveal sits just below "Open" and
          BEFORE the first separator (UI-SPEC §Surface 4 Mount A). */}
      {rowKind === "note" && revealItem}
      {rowKind === "note" && <Sep style={separatorStyle} />}
      {/* Plan 08-06 Mount A — file rows: Reveal is the TOP item, before
          any other action (UI-SPEC §Surface 4 Mount A). File rows
          otherwise only have Rename + Delete (07-38 R7b). */}
      {isFile && revealItem}
      {!isFile && (
        <Item
          style={itemStyle}
          onSelect={(event: Event) => {
            // UX-12 / Pitfall 7 (RESEARCH §A6): right-clicking "New note"
            // inside an expanded folder must NOT collapse that folder.
            // Radix's onSelect fires BEFORE the menu closes and is handed
            // the original click event; halting propagation here prevents
            // the synthesized click from bubbling to the row's onClick
            // handler (TreeRow.handleClick), which would otherwise toggle
            // the folder open/closed state.
            event.stopPropagation();
            onNewNote();
          }}
        >
          <span>New note</span>
        </Item>
      )}
      {rowKind !== "note" && !isFile && (
        <Item
          style={itemStyle}
          onSelect={(event: Event) => {
            // UX-12 / Pitfall 7 — same reasoning as the New note Item
            // above. Folder rows hosting "New folder" otherwise collapse
            // when the menu dismisses.
            event.stopPropagation();
            onNewFolder?.();
          }}
        >
          <span>New folder</span>
        </Item>
      )}
      {/* Plan 08-06 Mount A — folder rows: Reveal sits just below
          "New folder" and BEFORE the AI-grant submenu mount-slot
          (UI-SPEC §Surface 4 Mount A). The AI-grant submenu lands in
          Plan 08-10 — for now just leave a marker comment so the next
          plan knows the slot. */}
      {rowKind === "folder" && revealItem}
      {/* R4-9 (Plan 08-22): if an ANCESTOR folder holds a grant AND this
          folder has no direct grant of its own, replace the "Grant AI
          access ▸" submenu with a single DISABLED inheritance label.
          D-18 recursive coverage means the ancestor grant already covers
          this folder; offering a separate grant creates ambiguous state.
          To revoke the inherited grant, the user goes to the ancestor's
          menu (which is where the grant was attached). */}
      {rowKind === "folder" && inheritedGrant && !activeLevel && (
        <Item
          style={{ ...itemStyle, opacity: 0.6, cursor: "not-allowed" }}
          disabled
          onSelect={(e: Event) => {
            // Radix Item onSelect would close the menu — for a disabled
            // informational item we want neither close nor action.
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
      {/* Plan 08-10 (D-17, D-19, MCP-01) — "Grant AI access ▸" submenu mounts
          between Reveal and the Rename/Delete separator on folder rows only.
          The submenu offers Tier 1 (Edit only) + Tier 2 (Full) items; when a
          grant is already attached at this leaf, a "Revoke access" destructive
          item appears below a separator. Locked copy + locked layout from
          UI-SPEC §Surface 2 lines 180-194.

          R4-9 (Plan 08-22): suppressed when inheritedGrant exists AND no
          direct grant on this leaf — the disabled label above takes over. */}
      {rowKind === "folder" &&
        (onGrant || onRevoke) &&
        !(inheritedGrant && !activeLevel) && (
        // R4-12 (Plan 08-22): key the Sub on the activeLevel so a
        // grant change forces a clean unmount + remount. Without
        // this, Radix's internal Sub state machine restores
        // `data-state="open"` against the new SubTrigger render
        // (now showing Sparkles + tier label), surfacing as the
        // menu spontaneously re-opening ~1-2s after the user
        // clicked a tier. With the key, the entire Sub subtree
        // tears down on the optimistic setGrants and the WS
        // re-render simply mounts a fresh closed Sub.
        <Sub key={`sub-${activeLevel ?? "none"}`}>
          <SubTrigger style={itemStyle}>
            <span>Grant AI access</span>
            {/* UAT-2 R4-6: Sparkles icon next to the SubTrigger when this
                folder has an active grant — replaces the in-row indicator
                so the granted folder reads via background tint + the
                in-menu icon (legible only when the menu is open). Color
                tier matches the inline tint: violet-400 for Tier 1,
                violet-600 for Tier 2. */}
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
              {/* UAT-2 R4-5: data-active drives the global "active item"
                  CSS rule (theme.css) — stronger tint + left stripe + bold
                  weight so it stays distinguishable from hover (which uses
                  the same accent-12% background). */}
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

// ────────────────────────────────────────────────────────────────────
// Trigger variants
// ────────────────────────────────────────────────────────────────────

export function TreeRowContextMenu({
  children,
  onOpenChange,
  ...props
}: TreeRowMenuProps & {
  children: ReactNode;
  /**
   * R4-12 (Plan 08-22): receive Radix's open-state transitions so
   * TreeRow can observe menu-close events. Radix's ContextMenu.Root
   * is open-on-right-click and only exposes `onOpenChange` (not a
   * controlled `open` prop) — so we can't force-close from outside.
   * Instead, the R4-12 fix keys the `<Sub>` block on `activeLevel`
   * inside MenuItems, which guarantees full unmount + remount of the
   * SubContent when grants change. This callback is forwarded so
   * future surfaces can react to dismissals.
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
        {/* Open to the right of the kebab trigger with the top edge aligned
            to the trigger's top — keeps the source row visible (otherwise
            the default side="bottom" align="end" drops the menu over the
            narrow sidebar row the user just clicked). */}
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
