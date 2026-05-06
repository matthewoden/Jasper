package index

import (
	"github.com/matthewoden/jasper/backend/internal/markdown"
)

// ExtractTitle returns the first H1 heading from markdown content, or
// the filename without ".md" (filepath.Base + strip ".md") as fallback.
//
// This is a thin wrapper over markdown.ExtractTitle (the canonical
// implementation). The wrapper exists to preserve the exported
// `index.ExtractTitle` name that Plan 03-21 Task 1 introduced and that
// reconcile.go's two call sites depend on, while avoiding the
// notes → index import cycle that a co-located definition would have
// caused (package index imports package notes for NoteRecord, so
// package notes cannot import package index).
//
// The scanner contract — empty/nil content fallback, frontmatter
// handling, "#"-without-space tolerance, ## H2 not matched, 1 MiB
// long-line buffer, filename-fallback — is fully documented in
// markdown.ExtractTitle and tested by package markdown.
func ExtractTitle(content []byte, fallbackPath string) string {
	return markdown.ExtractTitle(content, fallbackPath)
}
