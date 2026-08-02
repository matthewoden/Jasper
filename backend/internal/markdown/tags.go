// Package markdown holds markdown helpers shared between the indexer
// (package index) and the notes service (package notes). It exists as a
// leaf package — depends on stdlib + goldmark extensions only, no
// project-internal imports — so that both packages can import it without
// creating an import cycle.
//
// The cycle is real: package index imports package notes for NoteRecord,
// NoteSummary, and the sentinel errors. Keeping this package as a leaf
// prevents that cycle from forming.
package markdown

import (
	"bytes"
	"regexp"
	"sort"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/parser"
	"go.abhg.dev/goldmark/frontmatter"
	"gopkg.in/yaml.v3"
)

// ExtractTags returns a normalized, deduplicated tag list.
//
// Malformed YAML returns nil, never an error — it must never prevent a save.
//
// nil vs empty-non-nil is meaningful: nil means "no frontmatter at all", empty
// means "frontmatter present with `tags: []`".
func ExtractTags(content []byte) []string {
	if len(content) == 0 {
		return nil
	}
	md := goldmark.New(goldmark.WithExtensions(&frontmatter.Extender{}))
	ctx := parser.NewContext()
	var buf bytes.Buffer
	if err := md.Convert(content, &buf, parser.WithContext(ctx)); err != nil {
		return nil
	}
	fm := frontmatter.Get(ctx)
	if fm == nil {
		return nil
	}
	var data struct {
		Tags []string `yaml:"tags"`
	}
	if err := fm.Decode(&data); err != nil {
		return nil
	}
	return dedupeTags(normalizeTagList(data.Tags))
}

func normalizeTag(raw string) string {
	raw = strings.ToLower(strings.TrimSpace(raw))
	var b strings.Builder
	for _, r := range raw {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func normalizeTagList(raw []string) []string {
	out := make([]string, 0, len(raw))
	for _, t := range raw {
		if n := normalizeTag(t); n != "" {
			out = append(out, n)
		}
	}
	return out
}

func dedupeTags(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, t := range in {
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	return out
}

var bodyTagRE = regexp.MustCompile("(?:^|[\\s(`\\[,;:!?.'\"—–-])#([a-zA-Z0-9_-]+)")

// ExtractBodyTags returns inline #tagname occurrences from the body, skipping
// headings and fenced code blocks.
//
// Inline code spans are deliberately NOT skipped server-side: the editor
// suppresses them visually, and backtick-span tracking here would add real
// complexity for a case users rarely hit. Pinned by the "InlineCodeTag" test.
func ExtractBodyTags(content []byte) []string {
	if len(content) == 0 {
		return nil
	}
	body := stripFrontmatterBlock(content)
	lines := bytes.Split(body, []byte("\n"))
	inFence := false
	var raw []string
	for _, line := range lines {
		trimmed := bytes.TrimSpace(line)

		if bytes.HasPrefix(trimmed, []byte("```")) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}

		if len(trimmed) >= 2 && trimmed[0] == '#' &&
			(trimmed[1] == ' ' || trimmed[1] == '#') {
			continue
		}
		matches := bodyTagRE.FindAllSubmatch(line, -1)
		for _, m := range matches {
			if len(m) > 1 && len(m[1]) > 0 {
				raw = append(raw, string(m[1]))
			}
		}
	}
	if len(raw) == 0 {
		return nil
	}
	result := dedupeTags(normalizeTagList(raw))
	sort.Strings(result)
	return result
}

func stripFrontmatterBlock(content []byte) []byte {
	openFence := []byte("---\n")
	if !bytes.HasPrefix(content, openFence) {
		if !bytes.HasPrefix(content, []byte("---")) {
			return content
		}
	}

	rest := content[len(openFence):]

	closeFence := []byte("\n---")
	idx := bytes.Index(rest, closeFence)
	if idx < 0 {
		return content
	}

	after := rest[idx+len(closeFence):]
	if len(after) > 0 && after[0] == '\n' {
		after = after[1:]
	}
	return after
}

// RewriteFrontmatterTags replaces the tags array structure-preservingly. An
// empty canonical list writes "tags: []" rather than omitting the key.
//
// Lives here rather than in notes so Service.Update can call it without an
// import cycle, and does its own range extraction to stay a leaf package.
func RewriteFrontmatterTags(content []byte, canonical []string) ([]byte, error) {
	openFence := []byte("---\n")
	if !bytes.HasPrefix(content, openFence) {
		return content, nil
	}
	rest := content[len(openFence):]
	closeFence := []byte("\n---")
	idx := bytes.Index(rest, closeFence)
	if idx < 0 {
		return content, nil
	}
	yamlBody := rest[:idx]

	var node yaml.Node
	if err := yaml.Unmarshal(yamlBody, &node); err != nil || node.Kind == 0 {
		return content, &rewriteError{msg: "RewriteFrontmatterTags: malformed YAML", cause: err}
	}
	if node.Kind != yaml.DocumentNode || len(node.Content) == 0 {
		return content, &rewriteError{msg: "RewriteFrontmatterTags: unexpected YAML document structure"}
	}
	mapping := node.Content[0]
	if mapping.Kind != yaml.MappingNode {
		return content, &rewriteError{msg: "RewriteFrontmatterTags: YAML root is not a mapping"}
	}

	tagsFound := false
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		keyNode := mapping.Content[i]
		valNode := mapping.Content[i+1]
		if keyNode.Value != "tags" {
			continue
		}
		tagsFound = true

		newItems := make([]*yaml.Node, 0, len(canonical))
		for _, tag := range canonical {
			newItems = append(newItems, &yaml.Node{
				Kind:  yaml.ScalarNode,
				Value: tag,
				Tag:   "!!str",
			})
		}
		valNode.Kind = yaml.SequenceNode
		valNode.Tag = "!!seq"
		valNode.Style = yaml.FlowStyle
		valNode.Content = newItems
		valNode.Value = ""
		break
	}

	if !tagsFound {
		keyNode := &yaml.Node{Kind: yaml.ScalarNode, Value: "tags", Tag: "!!str"}
		seqItems := make([]*yaml.Node, 0, len(canonical))
		for _, tag := range canonical {
			seqItems = append(seqItems, &yaml.Node{
				Kind:  yaml.ScalarNode,
				Value: tag,
				Tag:   "!!str",
			})
		}
		valNode := &yaml.Node{
			Kind:    yaml.SequenceNode,
			Tag:     "!!seq",
			Style:   yaml.FlowStyle,
			Content: seqItems,
		}
		mapping.Content = append(mapping.Content, keyNode, valNode)
	}

	newYAML, err := yaml.Marshal(&node)
	if err != nil {
		return content, &rewriteError{msg: "RewriteFrontmatterTags: marshal failed", cause: err}
	}
	newYAML = bytes.TrimRight(newYAML, "\n")

	fmEnd := len(openFence) + idx + len(closeFence)
	var out bytes.Buffer
	out.WriteString("---\n")
	out.Write(newYAML)
	out.WriteString("\n---")
	out.Write(content[fmEnd:])
	return out.Bytes(), nil
}

type rewriteError struct {
	msg   string
	cause error
}

func (e *rewriteError) Error() string {
	if e.cause != nil {
		return e.msg + ": " + e.cause.Error()
	}
	return e.msg
}

func (e *rewriteError) Unwrap() error { return e.cause }
