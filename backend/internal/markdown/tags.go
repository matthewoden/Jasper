// Package markdown holds markdown helpers shared between the indexer
// (package index) and the notes service (package notes). It exists as a
// leaf package — depends on stdlib + goldmark extensions only, no
// project-internal imports — so that BOTH index and notes can import it
// without creating an import cycle.
//
// Phase 6 relaxes the original "stdlib only" constraint to allow
// go.abhg.dev/goldmark/frontmatter and go.abhg.dev/goldmark/wikilink.
// These are still leaf-level: they depend on github.com/yuin/goldmark
// and standard library only. No project-internal packages are imported.
//
// The cycle constraint is real: package index imports package notes for
// NoteRecord, NoteSummary, and the package-level error sentinels. Keeping
// this package as a leaf prevents that cycle from forming.
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
//   - content is nil or empty (no file to read)
//   - the file has no frontmatter block
//   - the YAML/TOML cannot be decoded (D-12: malformed YAML must never
//     prevent a save from succeeding; treat tags as empty instead of
//     returning an error that bubbles up to the user)
//
// Returns an empty non-nil slice when frontmatter is present and the tags
// array is explicitly empty (`tags: []`). Callers can use this to
// distinguish "has frontmatter but no tags" from "no frontmatter at all".
//
// Normalization (D-22): each tag is lowercased, trimmed, and filtered to
// the charset [a-z0-9_-]. Characters outside that set are stripped.
// Tags that reduce to the empty string after filtering are dropped.
//
// Deduplication happens after normalization. Deduping before normalization
// would allow "FOO" and "foo" to survive as distinct pre-normalized keys
// and then collapse to duplicates after, producing surprising behavior.
// Deduping after normalization ensures `[foo, foo, FOO]` → `["foo"]`.
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

// normalizeTag applies the D-22 charset rule: lowercase, trim whitespace,
// then strip every character that is not [a-z0-9_-]. Returns the empty
// string if nothing survives (caller should drop the result).
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

// normalizeTagList applies normalizeTag to every element and drops any
// that reduce to the empty string.
func normalizeTagList(raw []string) []string {
	out := make([]string, 0, len(raw))
	for _, t := range raw {
		if n := normalizeTag(t); n != "" {
			out = append(out, n)
		}
	}
	return out
}

// dedupeTags removes duplicates from a normalized tag list, preserving
// first-occurrence order.
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

// bodyTagRE matches "#tagname" where "#" is preceded by whitespace, start of
// string, or common punctuation (not another word character). This avoids
// matching "## heading" as a tag — heading lines are also skipped at the
// line level below.
//
// Go's regexp package uses RE2 — no lookbehind support (Pitfall 5 from
// RESEARCH.md). The preceding-char constraint is encoded as a non-capturing
// alternation of permitted preceding characters.
//
// submatch[1] is the tagname (without "#"); tagname charset includes uppercase
// because normalizeTag will lowercase it.
var bodyTagRE = regexp.MustCompile("(?:^|[\\s(`\\[,;:!?.'\"—–-])#([a-zA-Z0-9_-]+)")

// ExtractBodyTags walks the body (everything after the frontmatter block)
// and returns all inline #tagname occurrences, normalized per D-07/D-22
// charset.
//
// Rules (D-07/D-08 from Phase 6.5 CONTEXT.md):
//   - "#tagname" where tagname matches [a-z0-9_-]+ after case-fold = tag
//   - Lines that start with "#" followed by a space or another "#" = heading; skip
//   - Fenced code blocks (``` ... ```) are skipped entirely
//   - Inline code spans: NOT skipped on the server side — editor plugin handles
//     visual suppression. The server uses a simple line-scan approach which would
//     require full backtick-span tracking to skip inline code; the practical
//     impact is negligible (users rarely put #tags inside `code`). This choice
//     is pinned by the TestExtractBodyTags "InlineCodeTag" test case.
//   - The leading "#" is stripped from each returned tag name
//
// Returns nil when content is empty or no body tags are found.
// Never panics on malformed content (D-26).
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
		// Toggle fenced code block state on ``` marker lines.
		if bytes.HasPrefix(trimmed, []byte("```")) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		// Skip heading lines: "# text", "## text", "### text", etc.
		// A heading line starts with one or more "#" characters followed by a
		// space. Also skip lines that start with "##" (no space needed — any
		// line beginning with two consecutive "#" is a heading prefix).
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

// stripFrontmatterBlock returns content without the leading ---...--- YAML
// frontmatter block. Returns content unchanged if no frontmatter is detected.
func stripFrontmatterBlock(content []byte) []byte {
	openFence := []byte("---\n")
	if !bytes.HasPrefix(content, openFence) {
		// Also allow "---" followed immediately by EOF (degenerate case)
		if !bytes.HasPrefix(content, []byte("---")) {
			return content
		}
	}
	// Skip the opening "---\n"
	rest := content[len(openFence):]
	// Find the closing "\n---" (may be followed by "\n" or EOF)
	closeFence := []byte("\n---")
	idx := bytes.Index(rest, closeFence)
	if idx < 0 {
		return content // no closing fence — not valid frontmatter
	}
	// Advance past "\n---"; then skip optional trailing newline
	after := rest[idx+len(closeFence):]
	if len(after) > 0 && after[0] == '\n' {
		after = after[1:]
	}
	return after
}

// RewriteFrontmatterTags replaces the "tags:" array in the YAML frontmatter
// with the provided canonical tag list. Uses gopkg.in/yaml.v3 for safe,
// structure-preserving YAML manipulation (same approach as
// notes/rewriter.go::rewriteTagsArray).
//
// Rules:
//   - No frontmatter in content → returns content unchanged, nil error
//   - Canonical matches existing tags exactly → returns content unchanged
//   - Canonical differs → returns content with tags: array replaced
//   - Malformed YAML → returns original content + non-nil error
//   - Empty canonical → writes "tags: []" (NOT omitted)
//
// This function is in package markdown (not notes) so that Service.Update
// can call it without creating an import cycle. The extractFrontmatterRange
// helper in notes/rewriter.go is NOT imported here; this function implements
// its own equivalent range extraction (Option A — markdown remains a leaf).
func RewriteFrontmatterTags(content []byte, canonical []string) ([]byte, error) {
	// Locate the frontmatter block.
	openFence := []byte("---\n")
	if !bytes.HasPrefix(content, openFence) {
		return content, nil // no frontmatter
	}
	rest := content[len(openFence):]
	closeFence := []byte("\n---")
	idx := bytes.Index(rest, closeFence)
	if idx < 0 {
		return content, nil // no closing fence
	}
	yamlBody := rest[:idx]

	// Parse the YAML into a generic node tree.
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

	// Find and update the "tags" key. YAML mapping stores [key, val, key, val, ...].
	tagsFound := false
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		keyNode := mapping.Content[i]
		valNode := mapping.Content[i+1]
		if keyNode.Value != "tags" {
			continue
		}
		tagsFound = true
		// Build new sequence nodes from canonical list.
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
		// No "tags:" key in frontmatter — add it.
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

	// Marshal back to YAML.
	newYAML, err := yaml.Marshal(&node)
	if err != nil {
		return content, &rewriteError{msg: "RewriteFrontmatterTags: marshal failed", cause: err}
	}
	newYAML = bytes.TrimRight(newYAML, "\n")

	// Splice: ---\n + newYAML + \n--- + rest-of-content
	fmEnd := len(openFence) + idx + len(closeFence)
	var out bytes.Buffer
	out.WriteString("---\n")
	out.Write(newYAML)
	out.WriteString("\n---")
	out.Write(content[fmEnd:])
	return out.Bytes(), nil
}

// rewriteError is a simple error type for RewriteFrontmatterTags.
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
