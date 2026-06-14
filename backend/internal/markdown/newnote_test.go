package markdown

import (
	"strings"
	"testing"
)

// TestNewDailyNoteContent verifies the canonical daily-note content helper.
//
// Assertions:
//   - Default template produces frontmatter + "# {date}\n\n"
//   - Custom template with {{date}} is substituted everywhere
//   - No {{date}} literals survive in any case
//   - Output is idempotent (two calls with same args → same bytes)
func TestNewDailyNoteContent(t *testing.T) {
	cases := []struct {
		name     string
		date     string
		template string
		wantSubs []string
		wantNot  []string
	}{
		{
			name:     "default template",
			date:     "2026-05-13",
			template: "",
			wantSubs: []string{"---", "tags: []", "# 2026-05-13"},
			wantNot:  []string{"{{date}}"},
		},
		{
			name:     "custom template with {{date}}",
			date:     "2026-05-13",
			template: "# Daily {{date}}\n\n## Notes\n",
			wantSubs: []string{"# Daily 2026-05-13", "## Notes"},
			wantNot:  []string{"{{date}}"},
		},
		{
			name:     "multiple {{date}} occurrences",
			date:     "2026-05-13",
			template: "# {{date}}\n\nCreated: {{date}}\n",
			wantSubs: []string{"# 2026-05-13", "Created: 2026-05-13"},
			wantNot:  []string{"{{date}}"},
		},
		{
			name:     "frontmatter scaffold prepended",
			date:     "2026-05-13",
			template: "# {{date}}\n\n",
			wantSubs: []string{"---\ntags: []", "---\n\n"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := string(NewDailyNoteContent(tc.date, tc.template))
			for _, want := range tc.wantSubs {
				if !strings.Contains(got, want) {
					t.Errorf("missing %q in output; got: %q", want, got)
				}
			}
			for _, dont := range tc.wantNot {
				if strings.Contains(got, dont) {
					t.Errorf("should not contain %q; got: %q", dont, got)
				}
			}

			got2 := string(NewDailyNoteContent(tc.date, tc.template))
			if got != got2 {
				t.Errorf("not idempotent:\n  first:  %q\n  second: %q", got, got2)
			}
		})
	}
}

// TestNewNoteContent verifies the canonical new-note scaffold.
//
// Every note creation path (sidebar New Note, pending-wiki-link Cmd-click,
// daily notes) must use NewNoteContent as the single source of truth for
// initial note content. Changes to the scaffold format must go through
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
			name:  "empty title becomes empty H1",
			title: "",
			want:  "---\ntags: []\n---\n\n# \n\n",
		},
		{
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
