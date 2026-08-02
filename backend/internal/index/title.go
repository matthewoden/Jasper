package index

import (
	"github.com/matthewoden/jasper/backend/internal/markdown"
)

// ExtractTitle wraps markdown.ExtractTitle, which owns the real contract.
//
// The wrapper exists only to avoid an import cycle: index imports notes for
// NoteRecord, so notes cannot import index.
func ExtractTitle(content []byte, fallbackPath string) string {
	return markdown.ExtractTitle(content, fallbackPath)
}
