package markdown

import (
	"bytes"
	"strings"
)

// NormalizeFrontmatterEOL rewrites a CRLF frontmatter block, fences included,
// to LF so it meets FrontmatterCanonicalContract. The body keeps its line
// endings, and anything that is not a closed CRLF block is returned as is.
func NormalizeFrontmatterEOL(content []byte) []byte {
	if !bytes.HasPrefix(content, []byte("---\r\n")) {
		return content
	}
	offset := len("---\r\n")
	for offset < len(content) {
		end := len(content)
		if nl := bytes.IndexByte(content[offset:], '\n'); nl >= 0 {
			end = offset + nl + 1
		}
		if line := bytes.TrimSuffix(bytes.TrimSuffix(content[offset:end], []byte("\n")), []byte("\r")); string(line) == "---" {
			block := bytes.ReplaceAll(content[:end], []byte("\r\n"), []byte("\n"))
			return append(block, content[end:]...)
		}
		offset = end
	}
	return content
}

// ReadID returns the value of the top-level `id` key as written in the
// frontmatter, and whether the key is present. The value is not validated;
// the caller decides what a well-formed id is.
func ReadID(content []byte) (string, bool) {
	content = NormalizeFrontmatterEOL(content)
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
// `---\nid: <id>\n---\n`. A CRLF block is normalized to LF first. Content
// that already carries the id is returned unchanged, so callers can detect a
// no-op with bytes.Equal.
func WithID(content []byte, id string) []byte {
	content = NormalizeFrontmatterEOL(content)
	line := "id: " + id + "\n"

	closeAt, ok := frontmatterClose(content)
	if !ok {
		out := make([]byte, 0, len(content)+len(line)+8)
		out = append(out, "---\n"...)
		out = append(out, line...)
		out = append(out, "---\n"...)
		return append(out, content...)
	}

	lines := idLines(content, closeAt)
	if len(lines) == 0 {
		out := make([]byte, 0, len(content)+len(line))
		out = append(out, content[:len("---\n")]...)
		out = append(out, line...)
		return append(out, content[len("---\n"):]...)
	}
	if len(lines) == 1 && string(content[lines[0].start:lines[0].end]) == line {
		return content
	}

	out := make([]byte, 0, len(content)+len(line))
	out = append(out, content[:lines[0].start]...)
	out = append(out, line...)
	cursor := lines[0].end
	for _, dup := range lines[1:] {
		out = append(out, content[cursor:dup.start]...)
		cursor = dup.end
	}
	return append(out, content[cursor:]...)
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
