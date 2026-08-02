package markdown

import (
	"bufio"
	"bytes"
)

// FrontmatterCanonicalContract is the single-sentence definition of
// "frontmatter is present" used across the entire codebase. It is exported
// so MCP tool descriptions, OpenAPI docs, and migration logs can cite the
// exact same wording the implementation enforces.
//
// Suitable to embed verbatim in tool descriptions and developer docs.
const FrontmatterCanonicalContract = "Frontmatter is present iff the file begins at byte 0 with the exact bytes \"---\\n\" (three hyphens + LF), AND a subsequent line consisting of exactly \"---\\n\" appears before EOF. Case-sensitive. No leading BOM, no leading whitespace, no CR/CRLF line endings, no four-or-more hyphens, no trailing space on the fence."

// HasFrontmatter answers "is the block delimited?", never "is the YAML valid?".
// The exact rule is FrontmatterCanonicalContract; it is deliberately strict, as
// vault files are LF-canonical.
//
// Every caller routes through here — a second implementation would drift
// loose-vs-strict.
func HasFrontmatter(content []byte) bool {
	if len(content) < 4 {
		return false
	}

	if !bytes.HasPrefix(content, []byte("---\n")) {
		return false
	}

	rest := content[len("---\n"):]
	sc := bufio.NewScanner(bytes.NewReader(rest))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if line == "---" {
			return true
		}
	}
	return false
}

// InjectFrontmatterScaffold prepends the canonical scaffold unless one is
// already present, so re-running the one-time migration is a safe no-op.
// Byte-identical to NewNoteContent for empty input.
//
// Title is embedded verbatim and NOT escaped — the caller owns that.
func InjectFrontmatterScaffold(content []byte, title string) []byte {
	if HasFrontmatter(content) {
		return content
	}
	return append(scaffoldFor(title), content...)
}

func scaffoldFor(title string) []byte {
	b := make([]byte, 0, 24+len(title))
	b = append(b, "---\ntags: []\n---\n\n# "...)
	b = append(b, title...)
	b = append(b, "\n\n"...)
	return b
}
