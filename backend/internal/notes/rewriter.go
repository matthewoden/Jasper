package notes

import (
	"bytes"
	"sort"
	"strings"

	"github.com/yuin/goldmark"
	goldmarkAst "github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	"go.abhg.dev/goldmark/frontmatter"
	"go.abhg.dev/goldmark/wikilink"
	"gopkg.in/yaml.v3"
)

func rewriteTagsArray(content []byte, oldName, newName string) []byte {
	fmStart, fmEnd, yamlBody, ok := extractFrontmatterRange(content)
	if !ok {
		return content
	}

	var node yaml.Node
	if err := yaml.Unmarshal(yamlBody, &node); err != nil || node.Kind == 0 {
		return content
	}

	if node.Kind != yaml.DocumentNode || len(node.Content) == 0 {
		return content
	}
	mapping := node.Content[0]
	if mapping.Kind != yaml.MappingNode {
		return content
	}

	modified := false
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		keyNode := mapping.Content[i]
		valNode := mapping.Content[i+1]
		if keyNode.Value != "tags" {
			continue
		}

		if valNode.Kind != yaml.SequenceNode {
			continue
		}

		var kept []*yaml.Node
		for _, item := range valNode.Content {
			if item.Value == oldName {
				modified = true
				if newName != "" {
					item.Value = newName
					kept = append(kept, item)
				}
			} else {
				kept = append(kept, item)
			}
		}
		if !modified {
			return content
		}
		valNode.Content = kept

		valNode.Style = yaml.FlowStyle
		break
	}
	if !modified {
		return content
	}

	newYAML, err := yaml.Marshal(&node)
	if err != nil {
		return content
	}

	newYAML = bytes.TrimRight(newYAML, "\n")

	var out bytes.Buffer
	out.Write(content[:fmStart])
	out.WriteString("---\n")
	out.Write(newYAML)
	out.WriteString("\n---")
	out.Write(content[fmEnd:])
	return out.Bytes()
}

func extractFrontmatterRange(content []byte) (fmStart, fmEnd int, yamlBody []byte, ok bool) {
	openFence := []byte("---\n")
	if !bytes.HasPrefix(content, openFence) {
		return 0, 0, nil, false
	}
	fmStart = 0
	afterOpen := len(openFence)

	rest := content[afterOpen:]
	closeFence := []byte("\n---")
	idx := bytes.Index(rest, closeFence)
	if idx < 0 {
		return 0, 0, nil, false
	}

	yamlBody = rest[:idx]

	fmEnd = afterOpen + idx + 4
	ok = true
	return
}

// RewriteWikilinksAST replaces every [[oldTitle]] and [[oldTitle|alias]]
// reference in content with [[newTitle]] / [[newTitle|alias]].
//
// Code-context skipping: goldmark/wikilink's parser respects CommonMark
// inline-parsing rules — code spans and fenced code blocks do NOT contain
// wikilink nodes in the AST. We walk the AST to collect all matching wikilink
// nodes, read their source byte positions via node.Pos() and the label Text
// child segment stop offset, then splice in reverse source order so earlier
// offsets remain valid.
//
// Alias preservation: [[Old|Alias]] is rewritten to [[New|Alias]]. The alias
// is taken from the child ast.Text node's segment.
//
// Matching is case-insensitive: [[FOO]], [[Foo]], and [[foo]] all match
// oldTitle "foo".
func RewriteWikilinksAST(content []byte, oldTitle, newTitle string) []byte {
	if len(content) == 0 {
		return content
	}

	md := goldmark.New(
		goldmark.WithExtensions(
			&frontmatter.Extender{},
			&wikilink.Extender{},
		),
	)

	reader := text.NewReader(content)
	doc := md.Parser().Parse(reader)

	type span struct {
		start, end int
		alias      []byte
	}
	var spans []span

	_ = goldmarkAst.Walk(doc, func(n goldmarkAst.Node, entering bool) (goldmarkAst.WalkStatus, error) {
		if !entering {
			return goldmarkAst.WalkContinue, nil
		}
		wl, ok := n.(*wikilink.Node)
		if !ok {
			return goldmarkAst.WalkContinue, nil
		}
		if !strings.EqualFold(string(wl.Target), oldTitle) {
			return goldmarkAst.WalkContinue, nil
		}

		start := wl.Pos()
		if start < 0 {
			return goldmarkAst.WalkContinue, nil
		}

		child, isText := wl.FirstChild().(*goldmarkAst.Text)
		if !isText {
			return goldmarkAst.WalkContinue, nil
		}

		end := child.Segment.Stop + 2

		raw := content[start:end]
		var alias []byte
		if pipeIdx := bytes.IndexByte(raw[2:], '|'); pipeIdx >= 0 {
			alias = raw[2+pipeIdx+1 : len(raw)-2]
		}

		spans = append(spans, span{start: start, end: end, alias: alias})
		return goldmarkAst.WalkContinue, nil
	})

	if len(spans) == 0 {
		return content
	}

	sort.Slice(spans, func(i, j int) bool { return spans[i].start > spans[j].start })

	out := append([]byte(nil), content...)
	for _, s := range spans {
		var replacement []byte
		if s.alias != nil {
			replacement = []byte("[[" + newTitle + "|" + string(s.alias) + "]]")
		} else {
			replacement = []byte("[[" + newTitle + "]]")
		}

		out = append(out[:s.start:s.start], append(replacement, out[s.end:]...)...)
	}
	return out
}
