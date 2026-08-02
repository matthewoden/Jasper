package markdown

import (
	"testing"
)

// TestExtractTags verifies the tag extraction contract.
//
// Invalid YAML or missing frontmatter → nil, no panic.
// Tag charset is [a-z0-9_-]; all other chars are stripped; duplicates
// collapse after normalization.
func TestExtractTags(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    []string
		wantNil bool
	}{
		{
			name:  "valid tags",
			input: "---\ntags: [foo, bar-baz]\n---\nbody",
			want:  []string{"foo", "bar-baz"},
		},
		{
			name:  "empty tags array",
			input: "---\ntags: []\n---",
			want:  []string{},
		},
		{
			name:    "no frontmatter at all",
			input:   "# Title\nbody",
			wantNil: true,
		},
		{
			name:    "invalid YAML inside frontmatter",
			input:   "---\ntags: [unclosed\n---\n",
			wantNil: true,
		},
		{
			name:  "normalization — lowercase and space stripped",
			input: "---\ntags: [\"  Foo Bar  \"]\n---",
			want:  []string{"foobar"},
		},
		{
			name:  "invalid chars stripped — slash and punctuation removed",
			input: "---\ntags: [\"foo/bar!\"]\n---",
			want:  []string{"foobar"},
		},
		{
			name:    "nil input",
			input:   "",
			wantNil: true,
		},
		{
			name:  "uppercase and non-ASCII stripped",
			input: "---\ntags: [\"PrøJect\"]\n---",

			want: []string{"prject"},
		},
		{
			name:  "TOML frontmatter",
			input: "+++\ntags = [\"foo\"]\n+++\nbody",
			want:  []string{"foo"},
		},
		{
			name:  "duplicate tags collapse",
			input: "---\ntags: [foo, foo, FOO]\n---",
			want:  []string{"foo"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ExtractTags([]byte(tc.input))
			if tc.wantNil {
				if got != nil {
					t.Errorf("expected nil, got %v", got)
				}
				return
			}
			if len(got) != len(tc.want) {
				t.Errorf("len mismatch: got %v (%d), want %v (%d)", got, len(got), tc.want, len(tc.want))
				return
			}
			for i, w := range tc.want {
				if got[i] != w {
					t.Errorf("[%d] got %q, want %q", i, got[i], w)
				}
			}
		})
	}
}

// TestExtractTags_NilInput specifically tests nil (not empty string) input.
func TestExtractTags_NilInput(t *testing.T) {
	got := ExtractTags(nil)
	if got != nil {
		t.Errorf("ExtractTags(nil) = %v, want nil", got)
	}
}

// TestExtractTags_EmptyTagsNonNil verifies that `tags: []` returns a non-nil
// empty slice so callers can distinguish "no frontmatter" from "empty tags".
func TestExtractTags_EmptyTagsNonNil(t *testing.T) {
	got := ExtractTags([]byte("---\ntags: []\n---"))
	if got == nil {
		t.Error("ExtractTags with empty tags array returned nil, want non-nil empty slice")
	}
	if len(got) != 0 {
		t.Errorf("got %v, want empty slice", got)
	}
}

// The "InlineCodeTag" case pins a deliberate choice: inline code spans DO
// contribute tags server-side, because the editor suppresses them visually and
// backtick tracking here is not worth the complexity.
func TestExtractBodyTags(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    []string
		wantNil bool
	}{
		{
			name:    "empty content",
			input:   "",
			wantNil: true,
		},
		{
			name:    "no hash occurrences",
			input:   "just some plain text",
			wantNil: true,
		},
		{
			name:  "tag at start of line",
			input: "#foo",
			want:  []string{"foo"},
		},
		{
			name:  "tag mid-line after whitespace",
			input: "text #foo more",
			want:  []string{"foo"},
		},
		{
			name:  "tag followed by period",
			input: "tagged #foo. here",
			want:  []string{"foo"},
		},
		{
			name:  "tag followed by comma",
			input: "tagged #foo, here",
			want:  []string{"foo"},
		},
		{
			name:  "tag followed by semicolon",
			input: "tagged #foo; here",
			want:  []string{"foo"},
		},
		{
			name:  "tag followed by exclamation",
			input: "tagged #foo! here",
			want:  []string{"foo"},
		},
		{
			name:  "tag followed by question mark",
			input: "tagged #foo? here",
			want:  []string{"foo"},
		},
		{
			name:  "tag followed by closing paren",
			input: "tagged (#foo)",
			want:  []string{"foo"},
		},
		{
			name:  "tag followed by closing bracket",
			input: "tagged [#foo]",
			want:  []string{"foo"},
		},
		{
			name:    "heading with space - not a tag",
			input:   "# Heading text",
			wantNil: true,
		},
		{
			name:    "h2 heading - not a tag",
			input:   "## Heading",
			wantNil: true,
		},
		{
			name:    "h3 heading - not a tag",
			input:   "### Subheading",
			wantNil: true,
		},
		{
			name:    "tag inside fenced code block - not extracted",
			input:   "```\n#foo\n```",
			wantNil: true,
		},
		{
			name: "tag inside inline code span - IS extracted (server-side behavior pinned)",

			input: "text `#foo` text",
			want:  []string{"foo"},
		},
		{
			name:  "tag in body after frontmatter - only body tag extracted",
			input: "---\ntags: [bar]\n---\n#foo",
			want:  []string{"foo"},
		},
		{
			name:  "uppercase tag normalized to lowercase",
			input: "#FOO",
			want:  []string{"foo"},
		},
		{
			name:  "duplicate tags deduplicated after normalization",
			input: "#foo\n#FOO\n#foo",
			want:  []string{"foo"},
		},
		{
			name:  "multiple distinct tags - sorted alphabetically",
			input: "#foo\n#bar",
			want:  []string{"bar", "foo"},
		},
		{
			name:  "tag with chars outside charset - truncated at first non-charset char",
			input: "#foo!@!",
			want:  []string{"foo"},
		},
		{
			name:  "tag with hyphen and underscore - valid charset",
			input: "#foo-bar_baz",
			want:  []string{"foo-bar_baz"},
		},
		{
			name:  "tag with digits - valid charset",
			input: "#tag123",
			want:  []string{"tag123"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ExtractBodyTags([]byte(tc.input))
			if tc.wantNil {
				if len(got) != 0 {
					t.Errorf("expected nil/empty, got %v", got)
				}
				return
			}
			if len(got) != len(tc.want) {
				t.Errorf("len mismatch: got %v (%d), want %v (%d)", got, len(got), tc.want, len(tc.want))
				return
			}
			for i, w := range tc.want {
				if got[i] != w {
					t.Errorf("[%d] got %q, want %q", i, got[i], w)
				}
			}
		})
	}
}

// TestRewriteFrontmatterTags verifies the frontmatter tag rewrite contract.
func TestRewriteFrontmatterTags(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		canonical []string
		wantSame  bool
		wantErr   bool
		checkTags []string
	}{
		{
			name:      "no frontmatter - content unchanged",
			input:     "# Title\nbody text",
			canonical: []string{"foo"},
			wantSame:  true,
		},
		{
			name:      "canonical same tags different order - result has canonical order",
			input:     "---\ntags: [foo, bar]\n---\nbody",
			canonical: []string{"bar", "foo"},
			wantSame:  false,
			checkTags: []string{"bar", "foo"},
		},
		{
			name:      "canonical differs - tags replaced",
			input:     "---\ntags: [foo]\n---\nbody",
			canonical: []string{"bar", "foo"},
			checkTags: []string{"bar", "foo"},
		},
		{
			name:      "malformed YAML - returns original content + error",
			input:     "---\ntags: [unclosed\n---\nbody",
			canonical: []string{"foo"},
			wantErr:   true,
			wantSame:  true,
		},
		{
			name:      "empty canonical - writes tags: []",
			input:     "---\ntags: [foo]\n---\nbody",
			canonical: []string{},
			checkTags: []string{},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := RewriteFrontmatterTags([]byte(tc.input), tc.canonical)
			if tc.wantErr && err == nil {
				t.Error("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			if tc.wantSame && string(got) != tc.input {
				t.Errorf("expected content unchanged, got different:\n  want: %q\n   got: %q", tc.input, string(got))
			}
			if tc.checkTags != nil {
				parsed := ExtractTags(got)
				if len(parsed) != len(tc.checkTags) {
					t.Errorf("tag count mismatch: got %v (%d), want %v (%d)", parsed, len(parsed), tc.checkTags, len(tc.checkTags))
					return
				}
				for i, w := range tc.checkTags {
					if parsed[i] != w {
						t.Errorf("[%d] got %q, want %q", i, parsed[i], w)
					}
				}
			}
		})
	}
}
