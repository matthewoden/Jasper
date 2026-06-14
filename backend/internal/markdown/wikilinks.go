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

// ExtractWikilinks walks the goldmark AST and returns every wikilink.Node
// found in the markdown body. Code spans, fenced code blocks, and YAML
// frontmatter content are excluded automatically:
//
//   - goldmark/wikilink respects CommonMark inline parsing rules — code
//     context suppresses the wiki-link tokenizer (empirically verified by
//     TestExtractWikilinks_A1Assumption).
//   - goldmark/frontmatter excludes the YAML/TOML block from the body parse,
//     so [[Title]] values inside frontmatter are never extracted.
//
// Return value ordering: source order (first occurrence first). Duplicates
// within a single note are preserved at this layer; the caller deduplicates
// per UNIQUE (source_id, target_title) in the backlinks table.
//
// Returns nil for nil or empty input.
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
