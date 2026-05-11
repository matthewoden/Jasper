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
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/parser"
	"go.abhg.dev/goldmark/frontmatter"
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
