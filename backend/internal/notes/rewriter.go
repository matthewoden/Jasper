package notes

// rewriter.go — Plan 06-05 Task 2.
// Byte-level rewriters for YAML tag arrays and wiki-link references.
//
// rewriteTagsArray: mutates the tags array in a YAML frontmatter block.
// RewriteWikilinksAST: replaces [[OldTitle]] references via goldmark AST walk.

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

// rewriteTagsArray replaces or removes a tag entry in the YAML frontmatter
// tags array.
//
// Rules:
//   - If content has no frontmatter: returned unchanged.
//   - If oldName is not in the tags array: returned unchanged.
//   - If newName == "": the entry is removed (delete semantics). If that was
//     the last tag, tags becomes an empty sequence (tags: []), NOT removed.
//   - If newName != "": the first matching entry (case-sensitive) is replaced.
//   - Only the `tags` key is modified; other YAML keys (e.g. title) are
//     unaffected.
//
// YAML round-trip note: gopkg.in/yaml.v3 may normalize the tags array from
// block sequence ("- foo\n- bar") to flow sequence ("- foo\n- bar"), but the
// final output is semantically identical. Tests assert on presence of values,
// not exact formatting — see T2.
func rewriteTagsArray(content []byte, oldName, newName string) []byte {
	// Locate the frontmatter block. We scan for the opening and closing ---
	// fences to extract the YAML body.
	fmStart, fmEnd, yamlBody, ok := extractFrontmatterRange(content)
	if !ok {
		return content // no frontmatter
	}

	// Parse the YAML into a generic node tree so we can find and modify only
	// the tags key without disturbing other keys.
	var node yaml.Node
	if err := yaml.Unmarshal(yamlBody, &node); err != nil || node.Kind == 0 {
		return content // malformed YAML — leave unchanged
	}

	// The top-level is a document node; the mapping is its first child.
	if node.Kind != yaml.DocumentNode || len(node.Content) == 0 {
		return content
	}
	mapping := node.Content[0]
	if mapping.Kind != yaml.MappingNode {
		return content
	}

	// Find the "tags" key in the mapping. A YAML mapping node stores keys and
	// values alternately: [key0, val0, key1, val1, ...].
	modified := false
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		keyNode := mapping.Content[i]
		valNode := mapping.Content[i+1]
		if keyNode.Value != "tags" {
			continue
		}
		// valNode must be a sequence.
		if valNode.Kind != yaml.SequenceNode {
			continue
		}

		var kept []*yaml.Node
		for _, item := range valNode.Content {
			if item.Value == oldName {
				modified = true
				if newName != "" {
					// Replace.
					item.Value = newName
					kept = append(kept, item)
				}
				// else: delete (do not append).
			} else {
				kept = append(kept, item)
			}
		}
		if !modified {
			return content // oldName not found in tags
		}
		valNode.Content = kept
		// Force flow style for the sequence so the output is compact.
		valNode.Style = yaml.FlowStyle
		break
	}
	if !modified {
		return content
	}

	// Marshal back to YAML. We use the document node so yaml.Marshal
	// produces a valid YAML document.
	newYAML, err := yaml.Marshal(&node)
	if err != nil {
		return content // marshal failure — leave unchanged
	}
	// yaml.Marshal appends a trailing "\n"; trim it since we will splice into
	// the original fences.
	newYAML = bytes.TrimRight(newYAML, "\n")

	// Splice: rebuild content as:
	//   content[:fmStart] + "---\n" + newYAML + "\n---" + content[fmEnd:]
	var out bytes.Buffer
	out.Write(content[:fmStart])
	out.WriteString("---\n")
	out.Write(newYAML)
	out.WriteString("\n---")
	out.Write(content[fmEnd:])
	return out.Bytes()
}

// extractFrontmatterRange returns the byte offsets and inner YAML body of the
// frontmatter block in content.
//
// fmStart: byte index of the first character of the opening "---" line.
// fmEnd: byte index of the character AFTER the closing "---" (i.e. just past
// the fence itself, before any trailing newline). The caller splices
// content[fmEnd:] as the remaining body.
//
// Returns ok=false when no frontmatter block is found.
func extractFrontmatterRange(content []byte) (fmStart, fmEnd int, yamlBody []byte, ok bool) {
	// Find opening "---\n".
	openFence := []byte("---\n")
	if !bytes.HasPrefix(content, openFence) {
		// Allow leading whitespace? HasFrontmatter does, but for rewriting
		// we require the file to already start with "---" (enforced by D-10).
		return 0, 0, nil, false
	}
	fmStart = 0
	afterOpen := len(openFence)

	// Scan for closing "---" on its own line.
	rest := content[afterOpen:]
	closeFence := []byte("\n---")
	idx := bytes.Index(rest, closeFence)
	if idx < 0 {
		return 0, 0, nil, false
	}

	yamlBody = rest[:idx]
	// fmEnd points to just past the closing "---" (the 3 dashes).
	// rest[idx] == '\n', rest[idx+1:idx+4] == "---"
	fmEnd = afterOpen + idx + 4 // len("\n---") = 4
	ok = true
	return
}

// RewriteWikilinksAST replaces every [[oldTitle]] and [[oldTitle|alias]]
// reference in content with [[newTitle]] / [[newTitle|alias]].
//
// Code-context skipping: goldmark/wikilink's parser respects CommonMark
// inline-parsing rules — code spans (`code`) and fenced code blocks (```) do
// NOT contain wikilink nodes in the AST (D-19, verified by Plan 06-03
// TestExtractWikilinks_A1Assumption). We walk the AST to collect all matching
// wikilink nodes, read their source byte positions via node.Pos() (set by
// goldmark's inline parser) and the label Text child segment stop offset, then
// splice in reverse source order so earlier offsets remain valid.
//
// Alias preservation (D-21): [[Old|Alias]] is rewritten to [[New|Alias]].
// The alias (label) is taken from the child ast.Text node's segment.
//
// Matching is case-insensitive: [[FOO]], [[Foo]], and [[foo]] all match
// oldTitle "foo" (D-20 resolution rule).
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
		alias      []byte // non-nil iff the original was [[Target|Alias]]
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

		// wl.Pos() is the byte offset of the '[' in '[[' (set by goldmark's
		// inline parser at the triggering character position).
		start := wl.Pos()
		if start < 0 {
			return goldmarkAst.WalkContinue, nil
		}

		// The child ast.Text node carries the label/alias segment.
		// Its Segment.Stop is the byte offset of the ']' in ']]'.
		child, isText := wl.FirstChild().(*goldmarkAst.Text)
		if !isText {
			return goldmarkAst.WalkContinue, nil
		}
		// end = stop + 2 to include the closing ']]'.
		end := child.Segment.Stop + 2

		// Determine if there is an alias. An alias exists when the source
		// bytes contain a '|' between '[[ and ]]'.
		raw := content[start:end]
		var alias []byte
		if pipeIdx := bytes.IndexByte(raw[2:], '|'); pipeIdx >= 0 {
			// alias is everything after the '|' and before ']]'.
			alias = raw[2+pipeIdx+1 : len(raw)-2]
		}

		spans = append(spans, span{start: start, end: end, alias: alias})
		return goldmarkAst.WalkContinue, nil
	})

	if len(spans) == 0 {
		return content
	}

	// Splice in reverse source order so earlier offsets remain valid as later
	// ones are replaced (larger offsets first).
	sort.Slice(spans, func(i, j int) bool { return spans[i].start > spans[j].start })

	out := append([]byte(nil), content...)
	for _, s := range spans {
		var replacement []byte
		if s.alias != nil {
			replacement = []byte("[[" + newTitle + "|" + string(s.alias) + "]]")
		} else {
			replacement = []byte("[[" + newTitle + "]]")
		}
		// Splice: out[:s.start] + replacement + out[s.end:]
		out = append(out[:s.start:s.start], append(replacement, out[s.end:]...)...)
	}
	return out
}
