// Package markdown holds tiny stdlib-only markdown helpers shared
// between the indexer (package index) and the notes service (package
// notes). It exists as a leaf package — depends on stdlib only — so
// that BOTH index and notes can import it without creating an import
// cycle.
//
// The cycle constraint is real: package index imports package notes
// for NoteRecord, NoteSummary, and the package-level error sentinels
// (notes.ErrCaseCollision, notes.ErrNotFound). When Plan 03-21 needed
// notes.Service.Move to call the same H1 + frontmatter scanner the
// indexer uses, putting the scanner inside index would have made
// notes → index → notes — a cycle. Lifting the scanner to this leaf
// package solves it without surgery on the index/notes coupling.
//
// index.ExtractTitle (backend/internal/index/title.go) is preserved
// as a thin wrapper that delegates to markdown.ExtractTitle so the
// existing call sites inside the index package — and any tests that
// reference the exported name — continue to compile unchanged.
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
// This is the canonical implementation. index.ExtractTitle is a thin
// re-export wrapper; notes.Service.Move calls markdown.ExtractTitle
// directly (Plan 03-21, Gap R2-6 server-side closure).
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
