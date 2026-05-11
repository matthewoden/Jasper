// Package markdown — Phase 6 goldmark parser stub.
//
// This file ensures go.mod tracks the goldmark extension dependencies as
// direct requires even before Plans 06-03+ add the real implementation.
// Plans 06-03+ will expand this into the full frontmatter + wiki-link AST
// walker used by notes.Service for tag sync and backlink extraction.
//
// Dependencies kept here:
//   - go.abhg.dev/goldmark/wikilink — wiki-link [[Title]] + [[Title|Alias]] parsing (LINKS-01)
//   - go.abhg.dev/goldmark/frontmatter — YAML frontmatter extraction for tags: [...] (TAGS-01)
//   - github.com/yuin/goldmark — goldmark parser core (direct dep for clarity)
package markdown

import (
	"github.com/yuin/goldmark"
	goldmarkfrontmatter "go.abhg.dev/goldmark/frontmatter"
	"go.abhg.dev/goldmark/wikilink"
)

// NewParser creates a goldmark parser with the wikilink and frontmatter
// extensions registered. This is the canonical parser for Phase 6 note
// processing — Plans 06-03+ replace this placeholder body with the full
// implementation (tag extraction, backlink extraction, ambiguity resolution).
//
// Placeholder: returns a goldmark.Markdown with extensions only; no walker
// is wired yet. Plans 06-03+ add ExtractFrontmatter and ExtractWikiLinks.
func NewParser() goldmark.Markdown {
	return goldmark.New(
		goldmark.WithExtensions(
			&goldmarkfrontmatter.Extender{},
			&wikilink.Extender{},
		),
	)
}
