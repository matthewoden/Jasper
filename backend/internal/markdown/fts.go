package markdown

import (
	"bytes"
	"strings"
)

// ExtractBodyForFTS strips leading frontmatter so "tags: [foo]" cannot pollute
// body matches. Unclosed frontmatter is left in place — better to over-index
// than to drop content.
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
