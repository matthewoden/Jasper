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
//     the open fence), missing close delimiter, the four bytes "---\r\n"
//     (CRLF on the open fence — out of contract per R4-5; vault files
//     are LF-canonical).
//
// Used by:
//   - The D-11 one-time startup migration (TAGS-EXT-03): "does this file
//     already have a frontmatter block?"
//   - InjectFrontmatterScaffold (idempotency guard): "is the scaffold
//     already present?"
//   - The D-10 auto-restore on save (TAGS-EXT-02): "should we inject?"
//   - The MCP create_note / update_note tools (R4-5) — they MUST route
//     through this function rather than duplicating the check.
//
// See FrontmatterCanonicalContract for the contract suitable for embedding
// in user-facing docs.
func HasFrontmatter(content []byte) bool {
	if len(content) < 4 {
		return false
	}
	// Strict byte-0 open fence: exactly "---\n", LF only. No leading
	// whitespace, no BOM, no CR.
	if !bytes.HasPrefix(content, []byte("---\n")) {
		return false
	}
	// Walk lines after the open fence looking for an exact "---" line
	// (terminated by LF or by EOF). The scanner's Text() strips the
	// terminating "\n" but NOT a preceding "\r" — so "---\r" indicates a
	// CRLF close fence and must be rejected.
	rest := content[len("---\n"):]
	sc := bufio.NewScanner(bytes.NewReader(rest))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if line == "---" {
			return true
		}
		// Anything that looks like a CRLF-encoded close fence ("---\r")
		// is explicitly OUT of contract (LF-canonical vault files only).
		// Other lines are interior YAML content — keep scanning.
	}
	return false
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
