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

	"github.com/matthewoden/jasper/backend/internal/markdown"
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

// RewriteWikilinksAST rewrites [[old]], [[old#fragment]] and their aliased
// forms case-insensitively, preserving the fragment and alias. Ref-shaped
// targets are not titles and are left alone.
//
// Splices in REVERSE source order so earlier byte offsets stay valid. Code
// spans and fenced blocks are skipped for free — goldmark puts no wikilink
// nodes inside them.
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
		prefix     string
		suffix     string
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
		var suffix string
		if wl.Fragment != nil {
			suffix = "#" + string(wl.Fragment)
		}
		if markdown.IsRefTarget(string(wl.Target) + suffix) {
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

		prefix := "[["
		if wl.Embed {
			prefix = "![["
		}
		raw := content[start+len(prefix) : end-2]
		if pipeIdx := bytes.IndexByte(raw, '|'); pipeIdx >= 0 {
			suffix += string(raw[pipeIdx:])
		}

		spans = append(spans, span{start: start, end: end, prefix: prefix, suffix: suffix})
		return goldmarkAst.WalkContinue, nil
	})

	if len(spans) == 0 {
		return content
	}

	sort.Slice(spans, func(i, j int) bool { return spans[i].start > spans[j].start })

	out := append([]byte(nil), content...)
	for _, s := range spans {
		replacement := []byte(s.prefix + newTitle + s.suffix + "]]")
		out = append(out[:s.start:s.start], append(replacement, out[s.end:]...)...)
	}
	return out
}
