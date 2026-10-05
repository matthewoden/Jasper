/**
 * refChip — a [[ns:kind/id]] rendered as a chip: a kind icon, the item's
 * current title, and a status colour. Previews come from the session cache
 * in itemsApi; a chip whose item is not yet known renders from the raw ref
 * and the plugin rebuilds once the batch answers.
 *
 * Security: every string reaches the DOM via textContent, never innerHTML.
 */
import { StateEffect } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { peekItem, resolveItems, type Item } from "../lib/itemsApi";


const REF_RE = /^[a-z]+:[a-z]+\/.+$/;
const FILE_RE = /^file:.+$/;

/** The reference grammar: ns:kind/id, with file: as the one kind-less prefix. */
export function isRefTarget(target: string): boolean {
  return REF_RE.test(target) || FILE_RE.test(target);
}

export interface ParsedRef {
  raw: string;
  namespace: string;
  /** For jasper: refs, "note", "blob" or "title"; otherwise the foreign kind. */
  kind: string;
  id: string;
}

export function parseRef(raw: string): ParsedRef {
  if (FILE_RE.test(raw) && !REF_RE.test(raw)) {
    return { raw, namespace: "file", kind: "file", id: raw.slice("file:".length) };
  }
  const colon = raw.indexOf(":");
  const slash = raw.indexOf("/", colon);
  return {
    raw,
    namespace: raw.slice(0, colon),
    kind: raw.slice(colon + 1, slash),
    id: raw.slice(slash + 1),
  };
}

/** The note id a ref navigates to, when it is a native note ref. */
export function noteIdOfRef(raw: string): string | null {
  const p = parseRef(raw);
  return p.namespace === "jasper" && p.kind === "note" ? p.id : null;
}

/** The blob id a ref names, when it is a native blob ref. */
export function blobIdOfRef(raw: string): string | null {
  const p = parseRef(raw);
  return p.namespace === "jasper" && p.kind === "blob" ? p.id : null;
}

// A short blob id is a prefix of its re-keyed long form, so a match only
// counts when the id ends there.
const ID_CHAR = /[A-Za-z0-9_-]/;

/**
 * Rewrites every reference to oldRef in the document so it names newRef.
 * The user's one-click fix for a replaced blob: an ordinary edit, saved like
 * any other, so the server's etag check still applies.
 */
export function replaceRefInDoc(view: EditorView, oldRef: string, newRef: string): void {
  const text = view.state.doc.toString();
  const changes: { from: number; to: number; insert: string }[] = [];
  let at = text.indexOf(oldRef);
  while (at >= 0) {
    const end = at + oldRef.length;
    if (!ID_CHAR.test(text.charAt(end))) {
      changes.push({ from: at, to: end, insert: newRef });
    }
    at = text.indexOf(oldRef, end);
  }
  if (changes.length > 0) view.dispatch({ changes, userEvent: "input" });
}

/** Dispatched once a batch of previews has landed, so chips can re-render. */
export const refItemsResolved = StateEffect.define<void>();

export type ChipState = "pending" | "ok" | "unknown" | "deleted" | "foreign";

export interface ChipModel {
  state: ChipState;
  label: string;
  icon: string;
  item: Item | undefined;
}

const KIND_ICON: Record<string, string> = { note: "📄", blob: "📎", foreign: "🔗" };

/** What a chip shows for a ref, given what the cache knows right now. */
export function chipModel(raw: string, display: string | null): ChipModel {
  const item = peekItem(raw);
  const parsed = parseRef(raw);
  const foreign = parsed.namespace !== "jasper";
  if (!item) {
    return {
      state: foreign ? "foreign" : "pending",
      label: display ?? raw,
      icon: foreign ? KIND_ICON.foreign : KIND_ICON[parsed.kind] ?? KIND_ICON.note,
      item,
    };
  }
  const icon = KIND_ICON[item.kind] ?? KIND_ICON.foreign;
  switch (item.status) {
    case "OK":
      return { state: "ok", label: display ?? item.title, icon, item };
    case "DELETED":
      return { state: "deleted", label: item.title || display || raw, icon, item };
    default:
      return { state: item.kind === "foreign" ? "foreign" : "unknown", label: display ?? item.title ?? raw, icon, item };
  }
}

function describe(item: Item): string[] {
  const rows = [item.title, `${item.kind} · ${item.status.toLowerCase()}`];
  if (item.updated_at) {
    const when = new Date(item.updated_at);
    rows.push(`${item.status === "DELETED" ? "deleted" : "updated"} ${Number.isNaN(when.getTime()) ? item.updated_at : when.toLocaleString()}`);
  }
  if (item.excerpt) rows.push(item.excerpt);
  return rows;
}

export class RefChipWidget extends WidgetType {
  constructor(
    public readonly raw: string,
    public readonly display: string | null,
    public readonly embed: boolean,
    public readonly model: ChipModel,
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = `cm-ref-chip cm-ref-chip-${this.model.state}`;
    span.dataset.ref = this.raw;
    span.dataset.state = this.model.state;
    span.dataset.testid = "ref-chip";
    const noteId = noteIdOfRef(this.raw);
    if (noteId) span.dataset.targetId = noteId;

    const icon = document.createElement("span");
    icon.className = "cm-ref-chip-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = this.model.icon;
    span.appendChild(icon);

    const label = document.createElement("span");
    label.className = "cm-ref-chip-label";
    label.textContent = this.model.label;
    span.appendChild(label);

    const item = this.model.item;
    // A blob whose bytes changed in place: say so, and offer the new id.
    if (item?.status === "DELETED" && item.replaced_by) {
      const newRef = `jasper:blob/${item.replaced_by}`;
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "cm-ref-chip-replaced";
      badge.dataset.testid = "ref-chip-replaced";
      badge.textContent = "replaced · use new version";
      badge.title = `Point this reference at ${newRef}`;
      badge.addEventListener("mousedown", (e) => e.preventDefault());
      badge.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        replaceRefInDoc(view, this.raw, newRef);
      });
      span.appendChild(badge);
    }
    if (item) {
      let card: HTMLElement | null = null;
      span.addEventListener("mouseenter", () => {
        card = buildHoverCard(item, span);
        document.body.appendChild(card);
      });
      span.addEventListener("mouseleave", () => {
        card?.remove();
        card = null;
      });
    }
    return span;
  }

  eq(other: WidgetType): boolean {
    if (!(other instanceof RefChipWidget)) return false;
    return (
      other.raw === this.raw &&
      other.display === this.display &&
      other.embed === this.embed &&
      other.model.state === this.model.state &&
      other.model.label === this.model.label &&
      other.model.item === this.model.item
    );
  }

  /** Clicks must reach linkClickHandler, as for a title link. */
  ignoreEvent(): boolean {
    return false;
  }
}

function buildHoverCard(item: Item, anchor: HTMLElement): HTMLElement {
  const card = document.createElement("div");
  card.className = "cm-ref-hover";
  card.dataset.testid = "ref-hover-card";
  const rect = anchor.getBoundingClientRect();
  card.style.position = "fixed";
  card.style.left = `${rect.left}px`;
  card.style.top = `${rect.bottom + 4}px`;
  for (const [i, text] of describe(item).entries()) {
    const row = document.createElement("div");
    row.className = i === 0 ? "cm-ref-hover-title" : "cm-ref-hover-row";
    if (i === 0 && item.status === "DELETED") row.style.textDecoration = "line-through";
    row.textContent = text;
    card.appendChild(row);
  }
  return card;
}

const wanted = new Set<string>();
const failedAt = new Map<string, number>();
const RETRY_AFTER_MS = 30_000;
let scheduled = false;

/** Called from a decoration pass for every ref it could not render fully. */
export function wantItem(raw: string): void {
  if (peekItem(raw)) return;
  const failed = failedAt.get(raw);
  if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return;
  wanted.add(raw);
}

/**
 * Fetch everything the last pass wanted, once, then tell the view. Runs on
 * a microtask so a single render pass costs one request.
 */
export function flushWantedItems(view: EditorView): void {
  if (scheduled || wanted.size === 0) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const ids = Array.from(wanted);
    wanted.clear();
    void resolveItems(ids)
      .catch((e: unknown) => {
        const now = Date.now();
        for (const id of ids) failedAt.set(id, now);
        console.warn("[jasper] ref previews failed:", e);
      })
      .then(() => {
        if (view.dom.isConnected) view.dispatch({ effects: refItemsResolved.of(undefined) });
      });
  });
}

export const __testing__ = {
  reset(): void {
    wanted.clear();
    failedAt.clear();
    scheduled = false;
  },
};
