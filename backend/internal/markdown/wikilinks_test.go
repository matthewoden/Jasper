package markdown

import (
	"testing"
)

// TestExtractWikilinks verifies the wiki-link extraction contract (LINKS-01, D-19).
//
// D-19: [[Title]] inside code spans, fenced code blocks, or YAML frontmatter
//
//	is treated as literal text — NOT extracted as a wiki-link reference.
//
// The tests in this file also close RESEARCH.md's open question "A1 assumption":
// goldmark/wikilink respects CommonMark code-context rules and does NOT parse
// [[Title]] inside code spans or fenced code blocks. Tests 5 and 6 verify A1.
func TestExtractWikilinks(t *testing.T) {
	tests := []struct {
		name string
		body string
		want []WikiLinkRef
	}{
		{
			name: "simple link",
			body: "see [[Foo]] for more",
			want: []WikiLinkRef{{Target: "Foo", Fragment: ""}},
		},
		{
			name: "aliased link",
			body: "see [[Foo|the foo doc]] please",
			want: []WikiLinkRef{{Target: "Foo", Fragment: ""}},
		},
		{
			name: "fragment link",
			body: "jump [[Foo#Section]]",
			want: []WikiLinkRef{{Target: "Foo", Fragment: "Section"}},
		},
		{
			name: "multiple links preserved — no dedupe at extract layer",
			body: "[[Alpha]] and [[Beta]] and [[Alpha]] again",
			want: []WikiLinkRef{
				{Target: "Alpha", Fragment: ""},
				{Target: "Beta", Fragment: ""},
				{Target: "Alpha", Fragment: ""},
			},
		},
		{
			// A1 assumption verification: inline code suppresses wiki-link parsing.
			// D-19: literal inside ANY code context.
			// RESEARCH.md MEDIUM-confidence assumption — this test PROVES A1 empirically.
			name: "inline code — wiki-links not extracted",
			body: "this is `[[Foo]]` literal",
			want: nil,
		},
		{
			// A1 assumption verification: fenced code blocks suppress wiki-link parsing.
			// D-19: fenced ``` code blocks are code context.
			name: "fenced code block — wiki-links not extracted",
			body: "```\nlots of [[Foo]] here\n```",
			want: nil,
		},
		{
			name: "nil input",
			body: "", // represents nil via []byte(tc.body) == nil check below
			want: nil,
		},
		{
			// Frontmatter values are not parsed for wiki-links (D-19).
			// goldmark/frontmatter excludes the YAML block from the body parse;
			// the wikilink extension sees body-only content.
			name: "links inside frontmatter not extracted",
			body: "---\ntags: [foo]\nother: [[Foo]]\n---\nbody text",
			want: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var input []byte
			if tc.body != "" || tc.name == "nil input" {
				input = []byte(tc.body)
			}
			// nil input case is handled here:
			if tc.name == "nil input" {
				input = nil
			}

			got := ExtractWikilinks(input)

			if len(tc.want) == 0 && len(got) == 0 {
				// Both nil or both empty — pass.
				return
			}
			if len(got) != len(tc.want) {
				t.Errorf("len mismatch: got %v (%d), want %v (%d)", got, len(got), tc.want, len(tc.want))
				return
			}
			for i, w := range tc.want {
				if got[i].Target != w.Target {
					t.Errorf("[%d] Target: got %q, want %q", i, got[i].Target, w.Target)
				}
				if got[i].Fragment != w.Fragment {
					t.Errorf("[%d] Fragment: got %q, want %q", i, got[i].Fragment, w.Fragment)
				}
			}
		})
	}
}

// TestExtractWikilinks_NilInput explicitly tests the nil input path.
func TestExtractWikilinks_NilInput(t *testing.T) {
	got := ExtractWikilinks(nil)
	if got != nil {
		t.Errorf("ExtractWikilinks(nil) = %v, want nil", got)
	}
}

// TestExtractWikilinks_A1Assumption verifies the RESEARCH.md A1 assumption
// that goldmark/wikilink respects CommonMark code-context rules.
// This test is the empirical proof that Plan 06-03 committed to provide.
func TestExtractWikilinks_A1Assumption(t *testing.T) {
	// Inline code span
	inlineCode := "text `[[InCode]]` more text"
	if got := ExtractWikilinks([]byte(inlineCode)); len(got) != 0 {
		t.Errorf("A1 FAILED: [[InCode]] inside backtick code span was extracted: %v", got)
	}

	// Fenced code block
	fencedCode := "```go\nfmt.Println(\"[[InFence]]\")\n```"
	if got := ExtractWikilinks([]byte(fencedCode)); len(got) != 0 {
		t.Errorf("A1 FAILED: [[InFence]] inside fenced code block was extracted: %v", got)
	}
}
