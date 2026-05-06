package index

import (
	"bufio"
	"bytes"
	"path/filepath"
	"strings"
)

// ExtractTitle returns the first H1 heading from markdown content, or
// the filename without ".md" (filepath.Base + strip ".md") as fallback.
//
// YAML frontmatter (--- ... ---) at the top of the file is skipped
// before scanning for headings (DESIGN.md §7). The scanner enters
// "in-frontmatter" mode if the very first non-empty line is "---" and
// exits when it sees the matching closing "---".
//
// Per UI-SPEC voice rules: titles are returned VERBATIM from the file —
// no auto-capitalization, no truncation, no Unicode normalization
// beyond what was already in the source bytes. The UI is responsible
// for any truncation; the indexer stores the title as-is so [[wiki-link]]
// resolution (Phase 6) can match against it character-for-character.
//
// Phase 6 is expected to add an H2-fallback ("first H1, else first
// H2"); for Phase 2 we stop at the first non-blank non-heading line
// and fall through to filename. The plan keeps the scope tight.
//
// Defensive behaviors:
//
//   - Empty / nil content → filename fallback.
//   - Frontmatter without a closing "---" → consumed to EOF; filename
//     fallback applies.
//   - Long lines: scanner buffer is bumped to 1 MiB so a degenerate
//     "single 100 KB line" file does not error out (the filename
//     fallback applies because the line is not an H1).
//   - "#" with no space (e.g. "#tag" → ATX H1 requires the space per
//     CommonMark §4.2): treated as not-a-heading.
//   - Multiple leading "#" before the space (e.g. "## H2"): treated
//     as not-an-H1 (Phase 6 may extend; Phase 2 only matches "# ").
//
// Exported (PascalCase) so package `notes.Service.Move` can refresh
// the title field after a rename without duplicating the scanner.
// Plan 03-21 (Gap R2-6 server-side closure).
func ExtractTitle(content []byte, fallbackPath string) string {
	scanner := bufio.NewScanner(bytes.NewReader(content))
	// Bump the scanner buffer so a single >64 KB line does not bail
	// out with bufio.ErrTooLong. 1 MiB is generous; titles live on
	// the first few lines.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	inFrontmatter := false
	firstSignificantLineSeen := false

	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)

		// Detect frontmatter open on the first non-empty line. Markdown
		// frontmatter must be at the very top; we tolerate leading blank
		// lines for forgiveness but the spec is "first line".
		if !firstSignificantLineSeen {
			if trimmed == "" {
				continue
			}
			firstSignificantLineSeen = true
			if trimmed == "---" {
				inFrontmatter = true
				continue
			}
		} else if inFrontmatter {
			if trimmed == "---" {
				inFrontmatter = false
			}
			continue
		}

		if strings.HasPrefix(trimmed, "# ") {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, "# "))
		}

		// First non-blank, non-heading content line: bail out and fall
		// through to filename. (Phase 6 may walk further for an H2
		// fallback; Phase 2 deliberately stops here.)
		if trimmed != "" {
			break
		}
	}

	// Filename fallback. filepath.Base handles "/" and OS separators;
	// then strip a trailing ".md" (case-sensitive — canonicalized
	// upstream by fsstore.Canonicalize).
	name := filepath.Base(fallbackPath)
	name = strings.TrimSuffix(name, ".md")
	return name
}
