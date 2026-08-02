package markdown

import (
	"github.com/yuin/goldmark"
	goldmarkAst "github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	"go.abhg.dev/goldmark/frontmatter"
	"go.abhg.dev/goldmark/wikilink"
)

// WikiLinkRef is one occurrence of a [[Title]] or [[Title|Alias]] in note
// content. Target is the raw title text (no [[…]] markers, no fragment).
// Fragment is the optional #Section suffix; empty string if absent.
//
// Aliases are not surfaced here — wiki-link resolution depends only on
// Target. The render layer reads aliases directly from the source text.
//
// Example: [[Meeting Notes#Action Items]] → {Target: "Meeting Notes", Fragment: "Action Items"}
// Example: [[Foo|the foo doc]]           → {Target: "Foo", Fragment: ""}
type WikiLinkRef struct {
	Target   string
	Fragment string
}

// ExtractWikilinks returns every wikilink in source order, duplicates included —
// the caller deduplicates.
//
// Code spans, fenced blocks and frontmatter are excluded for free by goldmark's
// own parsing, not by anything here.
func ExtractWikilinks(content []byte) []WikiLinkRef {
	if len(content) == 0 {
		return nil
	}

	md := goldmark.New(
		goldmark.WithExtensions(
			&frontmatter.Extender{},
			&wikilink.Extender{},
		),
	)

	reader := text.NewReader(content)
	doc := md.Parser().Parse(reader)

	var refs []WikiLinkRef
	_ = goldmarkAst.Walk(doc, func(n goldmarkAst.Node, entering bool) (goldmarkAst.WalkStatus, error) {
		if !entering {
			return goldmarkAst.WalkContinue, nil
		}
		wl, ok := n.(*wikilink.Node)
		if !ok {
			return goldmarkAst.WalkContinue, nil
		}
		refs = append(refs, WikiLinkRef{
			Target:   string(wl.Target),
			Fragment: string(wl.Fragment),
		})
		return goldmarkAst.WalkContinue, nil
	})

	return refs
}
