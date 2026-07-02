// ExtractBodyForFTS strips YAML frontmatter from note content before
// indexing into body_fts so that "tags: [foo]" in frontmatter does not
// pollute full-text body matches.
//
// JoinTagNamesForFTS produces the space-joined list for tag_names_fts so
// that FTS5 unicode61 tokenizer treats each tag as a distinct query token.
//
// Relocated from internal/index/fts.go so internal/notes can populate
// NoteRecord.BodyFTS / TagNamesFTS on the interactive save paths (Update,
// createInternal, Move) without importing the index adapter package.
package markdown

import (
	"bytes"
	"strings"
)

// ExtractBodyForFTS strips a leading YAML frontmatter block (--- ... ---\n)
// from a markdown note's bytes and returns the remaining body as a string.
// Frontmatter content (esp. "tags: [foo]") MUST NOT pollute body matches.
// Idempotent on already-stripped content.
//
// Edge cases:
//   - No leading "---" prefix: returns full content unchanged.
//   - Opening "---" present but no closing "\n---": treats all content as body
//     (unclosed frontmatter is not stripped — better to over-index than drop content).
//   - Empty content: returns "".
func ExtractBodyForFTS(content []byte) string {
	if !bytes.HasPrefix(content, []byte("---")) {
		return string(content)
	}

	rest := content[3:]
	idx := bytes.Index(rest, []byte("\n---"))
	if idx == -1 {
		return string(content)
	}

	body := rest[idx+4:]

	if len(body) > 0 && (body[0] == '\n' || body[0] == '\r') {
		body = body[1:]
	}
	return strings.TrimLeft(string(body), "\n\r")
}

// JoinTagNamesForFTS returns the space-joined tag-name list used for the
// tag_names_fts column. Names are inserted exactly as the indexer normalized
// them (lowercase + trimmed) so FTS5 unicode61 tokenizer treats each as one token.
// Returns "" when the slice is nil or empty.
func JoinTagNamesForFTS(names []string) string {
	return strings.Join(names, " ")
}
