package markdown

import (
	"testing"
)

// TestHasFrontmatter verifies the frontmatter detection contract (TAGS-EXT-03, D-10, D-11).
//
// HasFrontmatter is the gate used by:
//   - D-11 one-time migration: "does this file already have frontmatter?"
//   - D-10 auto-restore on save: "should we inject the scaffold?"
//   - InjectFrontmatterScaffold (idempotency guard)
func TestHasFrontmatter(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{
			name:  "standard frontmatter block",
			input: "---\ntags: []\n---\nbody",
			want:  true,
		},
		{
			name:  "leading whitespace before fence — TrimSpace first",
			input: "  \n---\nfoo: bar\n---",
			want:  true,
		},
		{
			name:  "plain heading — no frontmatter",
			input: "# H1\nbody",
			want:  false,
		},
		{
			name:  "empty string",
			input: "",
			want:  false,
		},
		{
			name:  "only dashes inline — not a fence",
			input: "---abc",
			want:  false,
		},
		{
			name:  "only two dashes — not a valid fence",
			input: "--\nfoo",
			want:  false,
		},
		{
			name:  "unclosed frontmatter — opening fence with no closing fence",
			input: "---\nno closing fence\n",
			want:  false,
		},
		{
			name:  "frontmatter with content after close",
			input: "---\nkey: value\n---\n\n# Title\n\nbody text",
			want:  true,
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
			// Scaffold is prepended; existing H1 is preserved.
			name:  "body without frontmatter gets scaffold prepended",
			input: "# Foo\nbody",
			title: "Foo",
			want:  "---\ntags: []\n---\n\n# Foo\n\n# Foo\nbody",
		},
		{
			// Empty content: scaffold + trailing blank line.
			name:  "empty input gets scaffold with title",
			input: "",
			title: "NewNote",
			want:  "---\ntags: []\n---\n\n# NewNote\n\n",
		},
		{
			// Idempotency: content with frontmatter is returned unchanged (byte-identical).
			name:  "already has frontmatter — no-op idempotent",
			input: "---\ntags: [x]\n---\nbody",
			title: "X",
			want:  "---\ntags: [x]\n---\nbody",
		},
		{
			// Title with special characters — no escaping, caller's responsibility.
			// The apostrophe must round-trip into the H1.
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
