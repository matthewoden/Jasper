/**
 * MCP grant folder-path validator (Plan 08-04). Extracted from
 * McpSection.tsx so the component file only exports React components —
 * satisfies react-refresh/only-export-components and restores Fast
 * Refresh DX for the MCP setup section.
 *
 * Rejection rules (08-04 done-criteria gate the function name + each):
 *   - empty / whitespace-only string
 *   - contains `..` (path-escape attempt)
 *   - starts with `/` (POSIX absolute)
 *   - matches a Windows drive prefix (`C:\` / `c:/`)
 *   - contains non-printable / non-ASCII chars
 */
export function isValidGrantFolderPath(p: string): boolean {
  const trimmed = p.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("..")) return false;
  if (trimmed.startsWith("/")) return false;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return false;
  if (/[^\x20-\x7E]/.test(trimmed)) return false;
  return true;
}
