package markdown

import (
	"strings"
	"testing"
)

// TestHasFrontmatter verifies the canonical frontmatter detection contract
// (TAGS-EXT-03, D-10, D-11, R4-5 — Plan 08-21).
//
// HasFrontmatter is the SINGLE source of truth for "is a frontmatter block
// present in this file?" — duplicate implementations elsewhere in the tree
// would re-introduce the loose-vs-strict drift R4-5 was filed to fix.
//
// The contract (also recorded verbatim in FrontmatterCanonicalContract):
//
//	Frontmatter is present iff the file begins at byte 0 with the exact
//	bytes "---\n" (three hyphens + LF), AND a subsequent line consisting
//	of exactly "---\n" appears before EOF. Case-sensitive. No leading BOM,
//	no leading whitespace, no CR/CRLF line endings, no four-or-more
//	hyphens, no trailing space on the fence.
//
// The matrix below covers every rejection axis named in the contract.
func TestHasFrontmatter(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{
			name:  "canonical happy path — tags array + body",
			input: "---\ntags: []\n---\n# title\n",
			want:  true,
		},
		{
			name:  "canonical with body after close",
			input: "---\nkey: value\n---\n\n# Title\n\nbody text",
			want:  true,
		},
		{
			name:  "alt-cased key inside is irrelevant to detection",
			input: "---\nTags: [a]\n---\nbody",
			want:  true,
		},
		{
			name:  "canonical case key",
			input: "---\ntags: [a]\n---\nbody",
			want:  true,
		},

		{
			name:  "empty file",
			input: "",
			want:  false,
		},
		{
			name:  "BOM at byte 0 — out of contract",
			input: "\xef\xbb\xbf---\ntags: []\n---\n",
			want:  false,
		},
		{
			name:  "leading space — out of contract (byte-0 rule)",
			input: " ---\ntags: []\n---\n",
			want:  false,
		},
		{
			name:  "leading blank line — out of contract",
			input: "\n---\ntags: []\n---\n",
			want:  false,
		},
		{
			name:  "CRLF open fence — out of contract (LF-canonical)",
			input: "---\r\ntags: []\r\n---\r\n",
			want:  false,
		},
		{
			name:  "canonical CRLF row from plan — out of contract",
			input: "---\r\ntags: []\r\n---\r\n# body",
			want:  false,
		},
		{
			name:  "four hyphens — not a fence",
			input: "----\ntags: []\n----\n",
			want:  false,
		},
		{
			name:  "trailing space on open fence — not a fence",
			input: "--- \ntags: []\n---\n",
			want:  false,
		},
		{
			name:  "unclosed frontmatter — opening fence with no closing fence",
			input: "---\nno closing fence here\nfile ends without close",
			want:  false,
		},
		{
			name:  "only two dashes — not a valid fence",
			input: "--\nfoo\n---\n",
			want:  false,
		},
		{
			name:  "dashes inline — not a fence",
			input: "---abc\n---\n",
			want:  false,
		},
		{
			name:  "plain heading — no frontmatter",
			input: "# H1\nbody",
			want:  false,
		},
		{
			name:  "body-only with dashes in middle — not frontmatter",
			input: "# Title\n\n---\n\nHR, not frontmatter",
			want:  false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := HasFrontmatter([]byte(tc.input))
			if got != tc.want {
				t.Errorf("HasFrontmatter(%q) = %v, want %v", tc.input, got, tc.want)
			}
		})
	}
}

// TestHasFrontmatter_Nil tests nil input specifically.
func TestHasFrontmatter_Nil(t *testing.T) {
	if HasFrontmatter(nil) {
		t.Error("HasFrontmatter(nil) = true, want false")
	}
}

// TestFrontmatterCanonicalContract_SmokeContent guarantees the exported
// contract string contains the load-bearing phrases that downstream MCP
// tool descriptions cite. Catches accidental rewording that would drift
// the documented contract from the implementation.
func TestFrontmatterCanonicalContract_SmokeContent(t *testing.T) {
	must := []string{
		"byte 0",
		`"---\n"`,
		"Case-sensitive",
		"No leading BOM",
		"no leading whitespace",
		"no CR/CRLF",
	}
	for _, phrase := range must {
		if !strings.Contains(FrontmatterCanonicalContract, phrase) {
			t.Errorf("FrontmatterCanonicalContract missing required phrase %q", phrase)
		}
	}
}

// TestInjectFrontmatterScaffold verifies the scaffold injection contract (TAGS-EXT-02, TAGS-EXT-03, D-10, D-11).
//
// InjectFrontmatterScaffold must be idempotent: re-running on already-migrated files
// is a no-op (D-11 one-time migration can safely be retried on restart).
func TestInjectFrontmatterScaffold(t *testing.T) {
	tests := []struct {
		name  string
		input string
		title string
		want  string
	}{
		{
			name:  "body without frontmatter gets scaffold prepended",
			input: "# Foo\nbody",
			title: "Foo",
			want:  "---\ntags: []\n---\n\n# Foo\n\n# Foo\nbody",
		},
		{
			name:  "empty input gets scaffold with title",
			input: "",
			title: "NewNote",
			want:  "---\ntags: []\n---\n\n# NewNote\n\n",
		},
		{
			name:  "already has frontmatter — no-op idempotent",
			input: "---\ntags: [x]\n---\nbody",
			title: "X",
			want:  "---\ntags: [x]\n---\nbody",
		},
		{
			name:  "title with apostrophe round-trips into H1",
			input: "body text",
			title: "O'Hara",
			want:  "---\ntags: []\n---\n\n# O'Hara\n\nbody text",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := InjectFrontmatterScaffold([]byte(tc.input), tc.title)
			if string(got) != tc.want {
				t.Errorf("InjectFrontmatterScaffold(%q, %q):\n  got  %q\n  want %q", tc.input, tc.title, string(got), tc.want)
			}
		})
	}
}

// TestInjectFrontmatterScaffold_Idempotent explicitly asserts that calling
// InjectFrontmatterScaffold twice on the same content is a no-op on the second call.
func TestInjectFrontmatterScaffold_Idempotent(t *testing.T) {
	input := []byte("# Note\n\nSome content here.")
	title := "Note"

	first := InjectFrontmatterScaffold(input, title)
	second := InjectFrontmatterScaffold(first, title)

	if string(first) != string(second) {
		t.Errorf("InjectFrontmatterScaffold is not idempotent:\n  first:  %q\n  second: %q", string(first), string(second))
	}
}

// TestInjectFrontmatterScaffold_NilEquivalence verifies that
// InjectFrontmatterScaffold(nil, title) produces byte-identical output to
// NewNoteContent(title). This equivalence is required so new-note creation
// and scaffold-injection both produce the same canonical format.
func TestInjectFrontmatterScaffold_NilEquivalence(t *testing.T) {
	title := "X"
	fromInject := InjectFrontmatterScaffold(nil, title)
	fromNew := NewNoteContent(title)

	if string(fromInject) != string(fromNew) {
		t.Errorf("InjectFrontmatterScaffold(nil, %q) != NewNoteContent(%q):\n  inject: %q\n  new:    %q",
			title, title, string(fromInject), string(fromNew))
	}
}
