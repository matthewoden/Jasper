/**
 * nextUntitledName — pure function returning the lowest non-colliding
 * name in the form `${base}` or `${base} ${N}` (N starting at 1).
 *
 * Closes Gap 5 from 03-HUMAN-UAT.md: the toolbar `+` and `📁` buttons
 * always passed literal "untitled", which collides on the second click.
 *
 * Comparison is CASE-INSENSITIVE — matches the server's canonical-
 * collision rule (NFC + lowercase per fsstore.Canonicalize). For notes,
 * the caller strips `.md` from sibling note basenames before passing
 * them in; for folders, the caller passes the raw folder names.
 *
 * Algorithm: build a Set of lowercased existing names, then walk
 * candidate names base, `${base} 1`, `${base} 2`, ... until we find one
 * not in the set. O(N) where N is the smallest non-collider's index.
 *
 * Sparse gaps ARE filled — given `["untitled", "untitled 2"]`, the
 * result is `untitled 1` (the first hole). This matches Finder /
 * VS Code conventions.
 */
export function nextUntitledName(
  existing: readonly string[],
  base: string = "untitled",
): string {
  const lower = new Set<string>();
  for (const name of existing) {
    lower.add(name.toLowerCase());
  }
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 1; ; i++) {
    const candidate = `${base} ${i}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
    // Loop is bounded by Number.MAX_SAFE_INTEGER in theory; in
    // practice tree size is the bound and this returns within a few
    // iterations.
  }
}
