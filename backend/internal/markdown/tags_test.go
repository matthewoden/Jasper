package markdown

import (
	"testing"
)

// TestExtractTags verifies the tag extraction contract (TAGS-01, D-12, D-22).
//
// D-12: invalid YAML or missing frontmatter → nil, no panic.
// D-22: tag charset is [a-z0-9_-]; all other chars are stripped; duplicates
//
//	collapse after normalization.
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
			// P→p, r→r, ø stripped (non-ASCII), J→j, e→e, c→c, t→t = "prject"
			want: []string{"prject"},
		},
		{
			// TOML frontmatter — goldmark/frontmatter DOES support TOML (+++ fences).
			// Asserting the actual behavior: tags returned as expected.
			name:  "TOML frontmatter",
			input: "+++\ntags = [\"foo\"]\n+++\nbody",
			want:  []string{"foo"},
		},
		{
			// Duplicate tags collapse after normalization (D-22).
			// Tags: [foo, foo, FOO] — after normalize: [foo, foo, foo]; dedupe → [foo].
			// Comment in code explains why we dedupe AFTER normalization: if we deduped
			// before normalizing, "FOO" would slip through as a distinct key.
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
