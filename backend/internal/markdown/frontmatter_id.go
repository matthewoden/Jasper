package markdown

import (
	"bytes"
	"errors"
	"strings"
)

// ErrCRLFFrontmatter is returned by WithID for a file whose frontmatter uses
// CRLF line endings. Such a block is outside FrontmatterCanonicalContract, and
// inserting an LF line into it would leave the file half-converted.
var ErrCRLFFrontmatter = errors.New("markdown: frontmatter uses CRLF line endings")

// ReadID returns the value of the top-level `id` key as written in the
// frontmatter, and whether the key is present. The value is not validated;
// the caller decides what a well-formed id is.
func ReadID(content []byte) (string, bool) {
	closeAt, ok := frontmatterClose(content)
	if !ok {
		return "", false
	}
	for _, ln := range idLines(content, closeAt) {
		return idValue(content[ln.start:ln.end]), true
	}
	return "", false
}

// WithID returns content carrying exactly one top-level `id: <id>` line in its
// frontmatter and is otherwise byte-identical. An existing `id` line is
// replaced in place and any duplicates are dropped; a missing one is inserted
// as the first key; a file without frontmatter gains the minimal block
// `---\nid: <id>\n---\n`. Content that already carries the id is returned
// unchanged, so callers can detect a no-op with bytes.Equal.
func WithID(content []byte, id string) ([]byte, error) {
	if bytes.HasPrefix(content, []byte("---\r\n")) {
		return content, ErrCRLFFrontmatter
	}
	line := "id: " + id + "\n"

	closeAt, ok := frontmatterClose(content)
	if !ok {
		out := make([]byte, 0, len(content)+len(line)+8)
		out = append(out, "---\n"...)
		out = append(out, line...)
		out = append(out, "---\n"...)
		return append(out, content...), nil
	}

	lines := idLines(content, closeAt)
	if len(lines) == 0 {
		out := make([]byte, 0, len(content)+len(line))
		out = append(out, content[:len("---\n")]...)
		out = append(out, line...)
		return append(out, content[len("---\n"):]...), nil
	}
	if len(lines) == 1 && string(content[lines[0].start:lines[0].end]) == line {
		return content, nil
	}

	out := make([]byte, 0, len(content)+len(line))
	out = append(out, content[:lines[0].start]...)
	out = append(out, line...)
	cursor := lines[0].end
	for _, dup := range lines[1:] {
		out = append(out, content[cursor:dup.start]...)
		cursor = dup.end
	}
	return append(out, content[cursor:]...), nil
}

type lineSpan struct{ start, end int }

// idLines finds every line between the fences whose key is exactly `id` at
// column 0, which is what makes it a top-level key.
func idLines(content []byte, closeAt int) []lineSpan {
	var out []lineSpan
	start := len("---\n")
	for start < closeAt {
		end := closeAt
		if nl := bytes.IndexByte(content[start:closeAt], '\n'); nl >= 0 {
			end = start + nl + 1
		}
		if isIDLine(content[start:end]) {
			out = append(out, lineSpan{start, end})
		}
		start = end
	}
	return out
}

func isIDLine(line []byte) bool {
	if !bytes.HasPrefix(line, []byte("id:")) {
		return false
	}
	rest := bytes.TrimRight(line[len("id:"):], "\n")
	return len(rest) == 0 || rest[0] == ' ' || rest[0] == '\t'
}

func idValue(line []byte) string {
	v := strings.TrimSpace(strings.TrimPrefix(string(line), "id:"))
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
		return v[1 : len(v)-1]
	}
	if i := strings.Index(v, " #"); i >= 0 {
		v = strings.TrimSpace(v[:i])
	}
	return v
}
