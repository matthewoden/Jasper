/**
 * isValidGrantFolderPath — client-side MCP grant folder-path validator.
 * Extracted from McpSection.tsx so that file exports only React components
 * (required for react-refresh Fast Refresh).
 *
 * Rejects: empty/whitespace, `..` traversal, POSIX absolute (/), Windows
 * drive-letter absolute (C:\ / c:/), and non-printable/non-ASCII chars.
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
