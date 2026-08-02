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

// HasFrontmatter returns true iff content begins with a canonical YAML
// frontmatter block per the rule in FrontmatterCanonicalContract:
//
//   - The file MUST start at byte 0 with the exact four bytes "---\n"
//     (three hyphens followed by an LF). No leading BOM, no leading
//     whitespace (spaces, tabs, blank lines), no CR / CRLF.
//   - A subsequent line consisting of exactly "---\n" MUST appear before
//     end-of-file. (CR / CRLF closing lines are also rejected — vault
//     files are LF-canonical.)
//   - Detection is case-sensitive. The contents of the YAML body
//     (key casing, etc.) are irrelevant to detection: HasFrontmatter only
//     answers "is the block delimited?", not "is the YAML valid?".
//   - Rejected: "----\n" (four hyphens), "--- \n" (trailing space on
//     the open fence), missing close delimiter, "---\r\n" (CRLF on the
//     open fence — vault files are LF-canonical).
//
// Used by InjectFrontmatterScaffold (idempotency guard), the one-time
// startup migration, the auto-restore-on-save path, and the MCP
// create_note / update_note tools. All callers route through this
// function to avoid duplicate implementations.
//
// See FrontmatterCanonicalContract for the contract suitable for embedding
// in user-facing docs.
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

// InjectFrontmatterScaffold prepends the canonical scaffold to content IFF
// content does not already start with a frontmatter block. Returns content
// unchanged when HasFrontmatter is true (idempotent — re-running the
// one-time migration over an already-migrated file is a safe no-op).
//
// Scaffold format (byte-identical to NewNoteContent for empty input):
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

func scaffoldFor(title string) []byte {
	b := make([]byte, 0, 24+len(title))
	b = append(b, "---\ntags: []\n---\n\n# "...)
	b = append(b, title...)
	b = append(b, "\n\n"...)
	return b
}
