package markdown

import (
	"bytes"
	"regexp"
	"strings"

	"github.com/yuin/goldmark"
	goldmarkAst "github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"go.abhg.dev/goldmark/frontmatter"
	"go.abhg.dev/goldmark/wikilink"
)

// Ref is one reference a note makes: an inline [[...]] or ![[...]], or an
// entry of the frontmatter `refs:` list.
//
// Target is the link target as written. For a ref-shaped target
// (IsRefTarget) any #fragment is part of it, since the id may contain one;
// for a title link the fragment is split off into Fragment.
type Ref struct {
	Target   string
	Fragment string
	Display  string // alias text; "" when the link shows its target
	Position int    // byte offset of the link's opening bracket; -1 for a frontmatter ref
	Embed    bool
}

var (
	refTargetRE  = regexp.MustCompile(`^[a-z]+:[a-z]+/.+$`)
	fileTargetRE = regexp.MustCompile(`^file:.+$`)
)

// IsRefTarget reports whether target follows the reference grammar
// `ns:kind/id`, with `file:` as the one prefix that carries no kind. No note
// title can contain `/`, so a title and a ref never look alike.
func IsRefTarget(target string) bool {
	return refTargetRE.MatchString(target) || fileTargetRE.MatchString(target)
}

// ExtractRefs returns every reference in source order, frontmatter entries
// first, duplicates included. Code spans and fenced blocks contribute
// nothing, because goldmark parses no wikilink inside them.
func ExtractRefs(content []byte) []Ref {
	if len(content) == 0 {
		return nil
	}

	md := goldmark.New(goldmark.WithExtensions(&frontmatter.Extender{}, &wikilink.Extender{}))
	ctx := parser.NewContext()
	doc := md.Parser().Parse(text.NewReader(content), parser.WithContext(ctx))

	var refs []Ref
	if fm := frontmatter.Get(ctx); fm != nil {
		var data struct {
			Refs []string `yaml:"refs"`
		}
		if err := fm.Decode(&data); err == nil {
			for _, raw := range data.Refs {
				if t := strings.TrimSpace(raw); IsRefTarget(t) {
					refs = append(refs, Ref{Target: t, Position: -1})
				}
			}
		}
	}

	_ = goldmarkAst.Walk(doc, func(n goldmarkAst.Node, entering bool) (goldmarkAst.WalkStatus, error) {
		if !entering {
			return goldmarkAst.WalkContinue, nil
		}
		wl, ok := n.(*wikilink.Node)
		if !ok {
			return goldmarkAst.WalkContinue, nil
		}
		r := Ref{
			Target:   strings.TrimSpace(string(wl.Target)),
			Fragment: string(wl.Fragment),
			Position: wl.Pos(),
			Embed:    wl.Embed,
		}
		if joined := r.Target + "#" + r.Fragment; r.Fragment != "" && IsRefTarget(joined) {
			r.Target, r.Fragment = joined, ""
		}
		if child, isText := wl.FirstChild().(*goldmarkAst.Text); isText && r.Position >= 0 {
			raw := content[r.Position:child.Segment.Stop]
			if pipe := bytes.IndexByte(raw, '|'); pipe >= 0 {
				r.Display = strings.TrimSpace(string(raw[pipe+1:]))
			}
		}
		refs = append(refs, r)
		return goldmarkAst.WalkContinue, nil
	})
	return refs
}
