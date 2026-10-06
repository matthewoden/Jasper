/**
 * itemsApi — what a reference points at, and who references a target.
 *
 * Previews are batched: one POST /items/batch per render pass, and every
 * answer is cached for the session until an event that could change it. The
 * cache is keyed by the exact id string, so `jasper:note/X` and `X` are
 * separate entries, as the server treats them.
 */
import { client } from "../api/client";
import type { components } from "../api/schema";
import { isRefTarget, parseRef } from "./itemRef";
import { createKeyedResource, subscribe } from "./resources";

export type Item = components["schemas"]["Item"];
export type ItemKind = Item["kind"];
export type ItemStatus = Item["status"];

const cache = new Map<string, Item>();
const inFlight = new Map<string, Promise<void>>();

/** Any event after which a cached answer could be wrong. */
const ITEM_INVALIDATORS = [
  "note:created",
  "note:updated",
  "note:deleted",
  "note:moved",
  "file:created",
  "file:deleted",
  "file:moved",
  "links:rewritten",
  "refs:changed",
  "reindex:complete",
];

for (const ev of ITEM_INVALIDATORS) {
  subscribe(ev, () => {
    cache.clear();
    inFlight.clear();
  });
}

async function postItemsBatch(ids: string[]): Promise<Item[]> {
  const { data, error } = await client.POST("/items/batch", { body: { ids } });
  if (error || !data) {
    throw new Error("postItemsBatch: " + JSON.stringify(error ?? "no data"));
  }
  return data.items;
}

/** Read what is already known without asking the server. */
export function peekItem(id: string): Item | undefined {
  return cache.get(id);
}

/**
 * Resolve ids, asking the server only for those not yet cached. Ids already
 * on the wire from an earlier call are joined, not re-requested. Resolves to
 * the cached map so a caller can look up every id it asked for.
 */
export async function resolveItems(ids: string[]): Promise<Map<string, Item>> {
  const waits: Promise<void>[] = [];
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    if (cache.has(id)) continue;
    const pending = inFlight.get(id);
    if (pending) {
      waits.push(pending);
      continue;
    }
    missing.push(id);
  }
  if (missing.length > 0) {
    const request = postItemsBatch(missing)
      .then((items) => {
        for (const item of items) cache.set(item.id, item);
      })
      .finally(() => {
        for (const id of missing) inFlight.delete(id);
      });
    for (const id of missing) inFlight.set(id, request);
    waits.push(request);
  }
  await Promise.all(waits);
  return cache;
}

export type RefBacklinkRow = components["schemas"]["RefBacklinkRow"];

async function getRefBacklinks(targetRef: string): Promise<RefBacklinkRow[]> {
  const { data, error } = await client.GET("/refs/backlinks", {
    params: { query: { id: targetRef } },
  });
  if (error || !data) {
    throw new Error("getRefBacklinks: " + JSON.stringify(error ?? "no data"));
  }
  return data.backlinks;
}

/** Backlinks for any target ref, cached until a save changes references. */
export const refBacklinksResource = createKeyedResource("refBacklinks", getRefBacklinks, {
  mode: "cached",
  invalidatedBy: ["refs:changed", "note:deleted", "links:rewritten", "reindex:complete"],
});

export const __testing__ = {
  reset(): void {
    cache.clear();
    inFlight.clear();
  },
};

export type ItemSearchHit = components["schemas"]["ItemSearchHit"];

/** Notes by title and blobs by file name, for the @ picker. Not cached: a picker query is live. */
export async function searchItems(q: string, limit = 10): Promise<ItemSearchHit[]> {
  const { data, error } = await client.GET("/items/search", { params: { query: { q, limit } } });
  if (error || !data) {
    throw new Error("searchItems: " + JSON.stringify(error ?? "no data"));
  }
  return data.items;
}

export type NoteRef = components["schemas"]["NoteRef"];

async function getNoteRefs(noteId: string): Promise<NoteRef[]> {
  const { data, error } = await client.GET("/notes/{id}/refs", { params: { path: { id: noteId } } });
  if (error || !data) {
    throw new Error("getNoteRefs: " + JSON.stringify(error ?? "no data"));
  }
  return data.refs;
}

/** The references a note makes, keyed by note id; a save that changes them invalidates. */
export const noteRefsResource = createKeyedResource("noteRefs", getNoteRefs, {
  mode: "cached",
  invalidatedBy: ["refs:changed", "note:updated", "note:deleted", "reindex:complete"],
});

/** The namespace of a universal ref (`ado` for `ado:workitem/1`), or "" for a title. */
export function refNamespace(ref: string): string {
  return isRefTarget(ref) ? parseRef(ref).namespace : "";
}

/** Foreign refs by namespace, namespaces alphabetical, refs in document order. */
export function groupForeignRefs(refs: NoteRef[] | null | undefined): Array<[string, NoteRef[]]> {
  const groups = new Map<string, NoteRef[]>();
  for (const r of refs ?? []) {
    const ns = refNamespace(r.target_ref);
    if (ns === "" || ns === "jasper") continue;
    const list = groups.get(ns) ?? [];
    list.push(r);
    groups.set(ns, list);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
}
