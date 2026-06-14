package markdown

import "strings"

// NewNoteContent returns the canonical initial content for a freshly created
// note. Every create path — sidebar "New Note", pending-wiki-link Cmd-click
// create, and daily notes — MUST call this function so the frontmatter
// scaffold stays uniform across the app.
//
// Format (matches UI-SPEC §Copywriting Contract > Frontmatter scaffold):
//
//	---
//	tags: []
//	---
//
//	# {Title}
//
// (trailing blank line eases cursor placement when the note first opens)
//
// Title is embedded verbatim. An empty title produces an empty H1 ("# ").
// The caller is responsible for passing a non-empty, human-readable title
// (typically: the file name without ".md", already validated for filesystem
// safety by fsstore.Canonicalize).
//
// The returned byte slice is ready to pass directly to fsstore.AtomicWrite.
//
// Byte-identity guarantee: NewNoteContent(t) == InjectFrontmatterScaffold(nil, t).
// This is asserted by TestInjectFrontmatterScaffold_NilEquivalence to catch
// any future accidental divergence between the two code paths.
func NewNoteContent(title string) []byte {
	return scaffoldFor(title)
}

const frontmatterPrefix = "---\ntags: []\n---\n\n"

// NewDailyNoteContent constructs the content for a new daily note.
//
// Daily notes use the bare frontmatter prefix (---\ntags: []\n---\n\n) WITHOUT
// a scaffoldFor-derived H1 because the template body already contains the heading
// (default: "# {{date}}\n\n"). Using scaffoldFor would produce a duplicate H1.
// Instead we prepend the raw frontmatter prefix and append the substituted template.
//
// {{date}} substitution is applied to ALL occurrences in the template before prepending.
//
// If template is empty, defaults to "# {{date}}\n\n" (DESIGN.md §11 default).
//
// Idempotent: returns byte-identical output for identical (date, template) inputs.
func NewDailyNoteContent(date, template string) []byte {
	if template == "" {
		template = "# {{date}}\n\n"
	}
	body := strings.ReplaceAll(template, "{{date}}", date)
	return []byte(frontmatterPrefix + body)
}
