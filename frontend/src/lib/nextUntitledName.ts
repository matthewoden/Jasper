/**
 * Lowest non-colliding `${base}` / `${base} ${N}` name, so clicking + twice in
 * one folder cannot 409.
 *
 * Comparison is CASE-INSENSITIVE, matching the server's canonical-collision
 * rule. Callers strip `.md` before passing note names.
 *
 * Sparse gaps ARE filled — ["untitled", "untitled 2"] yields "untitled 1",
 * matching Finder and VS Code.
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
