// Package markdown — goldmark parser factory.
package markdown

import (
	"github.com/yuin/goldmark"
	goldmarkfrontmatter "go.abhg.dev/goldmark/frontmatter"
	"go.abhg.dev/goldmark/wikilink"
)

// NewParser creates a goldmark parser with the wikilink and frontmatter
// extensions registered.
func NewParser() goldmark.Markdown {
	return goldmark.New(
		goldmark.WithExtensions(
			&goldmarkfrontmatter.Extender{},
			&wikilink.Extender{},
		),
	)
}
