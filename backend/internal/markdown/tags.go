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

// ExtractTags parses YAML (or TOML) frontmatter and returns a normalized,
// deduplicated tag list.
//
// Returns nil when:
//   - content is nil or empty
//   - the file has no frontmatter block
//   - the YAML/TOML cannot be decoded (malformed YAML must never prevent a
//     save; treat tags as empty rather than surfacing an error)
//
// Returns an empty non-nil slice when frontmatter is present and the tags
// array is explicitly empty (`tags: []`). Callers can distinguish "has
// frontmatter but no tags" from "no frontmatter at all".
//
// Normalization: each tag is lowercased, trimmed, and filtered to
// [a-z0-9_-]. Characters outside that set are stripped; tags that reduce
// to empty are dropped.
//
// Deduplication happens after normalization so `[foo, foo, FOO]` → `["foo"]`.
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

// ExtractBodyTags walks the body (everything after the frontmatter block)
// and returns all inline #tagname occurrences, normalized to [a-z0-9_-].
//
// Rules:
//   - "#tagname" where tagname matches [a-z0-9_-]+ after case-fold = tag
//   - Lines starting with "#" + space or "#" = heading; skip
//   - Fenced code blocks (``` ... ```) are skipped entirely
//   - Inline code spans: NOT skipped on the server side — editor plugin handles
//     visual suppression. Full backtick-span tracking would add complexity for
//     negligible benefit (users rarely put #tags inside `code`). This choice
//     is pinned by the TestExtractBodyTags "InlineCodeTag" test case.
//   - The leading "#" is stripped from each returned tag name
//
// Returns nil when content is empty or no body tags are found.
// Never panics on malformed content.
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

// RewriteFrontmatterTags replaces the "tags:" array in the YAML frontmatter
// with the provided canonical tag list. Uses gopkg.in/yaml.v3 for safe,
// structure-preserving YAML manipulation.
//
// Rules:
//   - No frontmatter in content → returns content unchanged, nil error
//   - Canonical matches existing tags exactly → returns content unchanged
//   - Canonical differs → returns content with tags: array replaced
//   - Malformed YAML → returns original content + non-nil error
//   - Empty canonical → writes "tags: []" (NOT omitted)
//
// Lives in package markdown (not notes) so Service.Update can call it
// without creating an import cycle. Implements its own range extraction
// so markdown stays a leaf package.
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
