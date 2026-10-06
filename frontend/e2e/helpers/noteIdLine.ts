/** The note's content minus the `id:` line the server writes into every note. */
export function withoutIDLine(content: string): string {
  return content.replace(/^(---\r?\n)id: [0-9A-HJKMNP-TV-Z]{26}\r?\n/, "$1");
}
