package markdown

// NewNoteContent returns the canonical initial content for a freshly created
// note (TAGS-EXT-01 / D-09). Every create path — sidebar "New Note", the
// pending-wiki-link Cmd-click create (D-15), and Phase 7 daily notes — MUST
// call this function so the frontmatter scaffold stays uniform across the app.
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
