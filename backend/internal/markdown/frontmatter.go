package markdown

import (
	"bufio"
	"bytes"
)

// HasFrontmatter returns true iff content starts with a YAML frontmatter
// block: a "---" fence on its own line (optionally preceded by whitespace),
// followed by at least one more line, then a closing "---" fence on its
// own line.
//
// This is the gate used by:
//   - The D-11 one-time startup migration (TAGS-EXT-03): "does this file
//     already have a frontmatter block?"
//   - InjectFrontmatterScaffold (idempotency guard): "is the scaffold
//     already present?"
//   - The D-10 auto-restore on save (TAGS-EXT-02): "should we inject?"
//
// Precision requirements (mirrors title.go's frontmatter scanner):
//   - "---abc" on a single line (no newline after the fence) → false.
//   - "--\nfoo" (only two dashes) → false.
//   - "---\nno closing fence\n" (unclosed) → false.
//   - Leading whitespace / blank lines before "---" → true (TrimLeft first).
//
// A "---" line that appears mid-document (e.g., an HR after body text)
// returns false because the opening fence must be the first non-whitespace
// content in the file.
func HasFrontmatter(content []byte) bool {
	if len(content) == 0 {
		return false
	}
	// Skip leading whitespace (spaces, tabs, CR, LF). We do NOT use
	// bytes.TrimSpace here because we want to detect if the very first
	// non-whitespace content is a "---\n" line, not just a "---" anywhere.
	rest := bytes.TrimLeft(content, " \t\r\n")
	// Opening fence must be exactly "---" followed immediately by a newline
	// (LF or CRLF). Reject "---abc" or "---" at EOF.
	if !bytes.HasPrefix(rest, []byte("---\n")) && !bytes.HasPrefix(rest, []byte("---\r\n")) {
		return false
	}
	// Walk lines until we find the closing "---" fence. Cap scanner buffer
	// to 1 MiB (same as title.go) so a pathological long-line file does not
	// error out.
	sc := bufio.NewScanner(bytes.NewReader(rest))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	if !sc.Scan() {
		return false // could not even read the opening "---" line
	}
	// First line is "---"; scan remaining lines for the closing fence.
	for sc.Scan() {
		line := sc.Text()
		if line == "---" || line == "---\r" {
			return true
		}
	}
	return false // unclosed frontmatter → no valid block
}

// InjectFrontmatterScaffold prepends the canonical scaffold to content IFF
// content does not already start with a frontmatter block. Returns content
// unchanged when HasFrontmatter is true (idempotent — re-running the D-11
// one-time migration over an already-migrated file is a safe no-op).
//
// Scaffold format (matches UI-SPEC §Copywriting Contract > Frontmatter scaffold
// and is byte-identical to NewNoteContent for empty input):
//
//	---
//	tags: []
//	---
//
//	# {Title}
//
// Title is embedded verbatim in the H1. No escaping is performed; the
// caller is responsible for passing a title that is safe to embed in
// Markdown (e.g., stripping or escaping backticks, HTML entities, etc.).
//
// The trailing blank line after the H1 eases cursor placement when the
// user opens the freshly-created or just-migrated note.
func InjectFrontmatterScaffold(content []byte, title string) []byte {
	if HasFrontmatter(content) {
		return content
	}
	return append(scaffoldFor(title), content...)
}

// scaffoldFor returns the canonical frontmatter + H1 scaffold for the given
// title. Used internally by both InjectFrontmatterScaffold and NewNoteContent
// to guarantee byte-identical output for the empty-content case.
func scaffoldFor(title string) []byte {
	// Pre-allocate: "---\ntags: []\n---\n\n# " + title + "\n\n"
	// that is 22 + len(title) + 2 bytes.
	b := make([]byte, 0, 24+len(title))
	b = append(b, "---\ntags: []\n---\n\n# "...)
	b = append(b, title...)
	b = append(b, "\n\n"...)
	return b
}
