/**
 * The client's copy of the reference grammar in backend markdown/refs.go. The
 * editor draws chips synchronously, so it can't ask the server; ADR-0023
 * records why this one duplicate is allowed.
 */
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
