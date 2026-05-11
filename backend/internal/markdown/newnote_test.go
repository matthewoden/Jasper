package markdown

import (
	"strings"
	"testing"
)

// TestNewNoteContent verifies the canonical new-note scaffold (TAGS-EXT-01, D-09).
//
// Every note creation path (sidebar New Note, pending-wiki-link Cmd-click,
// Phase 7 daily notes) must use NewNoteContent as the single source of truth
// for initial note content. Changes to the scaffold format must go through
// this function.
func TestNewNoteContent(t *testing.T) {
	tests := []struct {
		name  string
		title string
		want  string
	}{
		{
			name:  "standard title",
			title: "Hello",
			want:  "---\ntags: []\n---\n\n# Hello\n\n",
		},
		{
			// Empty title becomes empty H1. Caller's responsibility to pass
			// a sensible title; NewNoteContent does not validate.
			name:  "empty title becomes empty H1",
			title: "",
			want:  "---\ntags: []\n---\n\n# \n\n",
		},
		{
			// Title with special characters — not escaped; caller handles escaping
			// if needed (e.g., for filesystem safety). The scaffold simply embeds
			// the title verbatim after "# ".
			name:  "title with special characters",
			title: "Meeting: Q1 2026",
			want:  "---\ntags: []\n---\n\n# Meeting: Q1 2026\n\n",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := NewNoteContent(tc.title)
			if string(got) != tc.want {
				t.Errorf("NewNoteContent(%q):\n  got  %q\n  want %q", tc.title, string(got), tc.want)
			}
		})
	}
}

// TestNewNoteContent_Format verifies the structural properties of the scaffold:
// - Starts with "---\n"
// - Contains "tags: []"
// - Contains the H1 heading
// - Ends with a trailing blank line (double newline)
func TestNewNoteContent_Format(t *testing.T) {
	content := NewNoteContent("Test Note")
	s := string(content)

	if !strings.HasPrefix(s, "---\n") {
		t.Errorf("NewNoteContent does not start with YAML fence: %q", s)
	}
	if !strings.Contains(s, "tags: []") {
		t.Errorf("NewNoteContent missing tags: []: %q", s)
	}
	if !strings.Contains(s, "# Test Note") {
		t.Errorf("NewNoteContent missing H1: %q", s)
	}
	if !strings.HasSuffix(s, "\n\n") {
		t.Errorf("NewNoteContent does not end with trailing blank line: %q", s)
	}
}

// TestNewNoteContent_MatchesUISpec verifies that the scaffold exactly matches
// the UI-SPEC §Copywriting Contract > Frontmatter scaffold:
//
//	---
//	tags: []
//	---
//
//	# {Title}
//
// (trailing blank line for cursor placement ease)
func TestNewNoteContent_MatchesUISpec(t *testing.T) {
	const title = "My Note"
	const expected = "---\ntags: []\n---\n\n# My Note\n\n"
	got := string(NewNoteContent(title))
	if got != expected {
		t.Errorf("NewNoteContent does not match UI-SPEC scaffold:\n  got  %q\n  want %q", got, expected)
	}
}
