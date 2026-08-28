/**
 * RenameInput helpers. Extracted from
 * RenameInput.tsx so the component file only exports React components —
 * satisfies react-refresh/only-export-components and restores Fast
 * Refresh DX for the inline rename input.
 */

// eslint-disable-next-line no-control-regex -- intentionally rejects ASCII control chars in user-typed names
const ILLEGAL_CHAR_REGEX = /[/\\:*?"<>|\x00-\x1F]/;

export interface ValidateResult {
  valid: boolean;
  error?: string;
}

export interface ValidateRenameOptions {
  /** Bookmark folders are virtual labels rather than paths, so the
   *  filesystem-legal-character rule must not apply to them. */
  allowAnyCharacters?: boolean;
}

export function validateRename(
  value: string,
  siblingNames: string[],
  opts: ValidateRenameOptions = {},
): ValidateResult {
  if (value === "") return { valid: false, error: "Name cannot be empty." };
  if (!opts.allowAnyCharacters && ILLEGAL_CHAR_REGEX.test(value))
    return {
      valid: false,
      error: "Use letters, numbers, dashes, and underscores only.",
    };
  const lower = value.toLowerCase();
  for (const sib of siblingNames) {
    if (sib.toLowerCase() === lower)
      return { valid: false, error: "Already exists." };
  }
  return { valid: true };
}
