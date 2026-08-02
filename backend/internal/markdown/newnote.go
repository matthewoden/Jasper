package markdown

import "strings"

// NewNoteContent is the canonical initial content. Every create path must call
// it so the scaffold stays uniform.
//
// Title is embedded verbatim; an empty one produces an empty H1.
//
// Guaranteed byte-identical to InjectFrontmatterScaffold(nil, t), asserted by
// TestInjectFrontmatterScaffold_NilEquivalence.
func NewNoteContent(title string) []byte {
	return scaffoldFor(title)
}

const frontmatterPrefix = "---\ntags: []\n---\n\n"

// NewDailyNoteContent prepends the bare frontmatter prefix WITHOUT a derived H1
// — the template body already carries one, and scaffoldFor would duplicate it.
//
// {{date}} is substituted at every occurrence.
func NewDailyNoteContent(date, template string) []byte {
	if template == "" {
		template = "# {{date}}\n\n"
	}
	body := strings.ReplaceAll(template, "{{date}}", date)
	return []byte(frontmatterPrefix + body)
}
