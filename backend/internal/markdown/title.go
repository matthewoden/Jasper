// Package markdown holds tiny stdlib-only markdown helpers shared
// between the indexer (package index) and the notes service (package
// notes). It exists as a leaf package — depends on stdlib only — so
// that both packages can import it without creating an import cycle.
//
// The cycle is real: package index imports package notes for NoteRecord,
// NoteSummary, and the sentinel errors. Keeping this package as a leaf
// prevents that cycle from forming.
//
// index.ExtractTitle (backend/internal/index/title.go) is a thin wrapper
// that delegates to markdown.ExtractTitle so existing call sites inside
// the index package continue to compile unchanged.
package markdown

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
// before scanning for headings. The scanner enters "in-frontmatter"
// mode if the very first non-empty line is "---" and exits on the
// matching closing "---".
//
// Titles are returned VERBATIM — no auto-capitalization, no truncation,
// no Unicode normalization. The UI is responsible for any truncation;
// the indexer stores the title as-is so wiki-link resolution can match
// character-for-character.
//
// Defensive behaviors:
//
//   - Empty / nil content → filename fallback.
//   - Frontmatter without a closing "---" → consumed to EOF; filename
//     fallback applies.
//   - Long lines: scanner buffer is bumped to 1 MiB so a degenerate
//     "single 100 KB line" file does not error out.
//   - "#" with no space (e.g. "#tag"): treated as not-a-heading per
//     CommonMark §4.2.
//   - Multiple leading "#" (e.g. "## H2"): treated as not-an-H1.
//
// index.ExtractTitle is a thin re-export wrapper; notes.Service.Move
// calls markdown.ExtractTitle directly.
func ExtractTitle(content []byte, fallbackPath string) string {
	scanner := bufio.NewScanner(bytes.NewReader(content))

	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	inFrontmatter := false
	firstSignificantLineSeen := false

	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)

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

		if trimmed != "" {
			break
		}
	}

	name := filepath.Base(fallbackPath)
	name = strings.TrimSuffix(name, ".md")
	return name
}
