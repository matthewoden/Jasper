package markdown

import (
	"strings"
	"testing"
)

func TestExtractTitle_FirstH1(t *testing.T) {
	got := ExtractTitle([]byte("# Welcome to Jasper\n\nbody text"), "notes/welcome.md")
	if got != "Welcome to Jasper" {
		t.Errorf("got %q, want %q", got, "Welcome to Jasper")
	}
}

func TestExtractTitle_NoH1_FallsBackToFilename(t *testing.T) {
	got := ExtractTitle([]byte("body without heading\nmore body"), "notes/foo/bar.md")
	if got != "bar" {
		t.Errorf("got %q, want %q", got, "bar")
	}
}

func TestExtractTitle_FrontmatterSkipped(t *testing.T) {
	content := "---\ntags: [a, b]\ntitle: not-this\n---\n# Real Title\n\nbody"
	got := ExtractTitle([]byte(content), "notes/x.md")
	if got != "Real Title" {
		t.Errorf("got %q, want %q", got, "Real Title")
	}
}

func TestExtractTitle_PreservesUnicodeAndPunctuation(t *testing.T) {
	got := ExtractTitle([]byte("# Café — Notes"), "notes/cafe.md")
	if got != "Café — Notes" {
		t.Errorf("got %q, want %q", got, "Café — Notes")
	}
}

func TestExtractTitle_EmptyFile_ReturnsFilename(t *testing.T) {
	got := ExtractTitle([]byte(""), "notes/blank.md")
	if got != "blank" {
		t.Errorf("got %q, want %q", got, "blank")
	}
}

func TestExtractTitle_NilContent_ReturnsFilename(t *testing.T) {
	got := ExtractTitle(nil, "notes/nil.md")
	if got != "nil" {
		t.Errorf("got %q, want %q", got, "nil")
	}
}

func TestExtractTitle_OnlyFrontmatter_NoH1_ReturnsFilename(t *testing.T) {
	content := "---\ntags: [a]\n---\n"
	got := ExtractTitle([]byte(content), "notes/no-h1.md")
	if got != "no-h1" {
		t.Errorf("got %q, want %q", got, "no-h1")
	}
}

func TestExtractTitle_LongFirstLine(t *testing.T) {
	long := strings.Repeat("x", 100*1024)
	got := ExtractTitle([]byte(long), "notes/huge.md")
	if got != "huge" {
		t.Errorf("got %q, want %q", got, "huge")
	}
}

func TestExtractTitle_HashWithoutSpace_NotAHeading(t *testing.T) {
	got := ExtractTitle([]byte("#tag\nbody"), "notes/hashtag.md")
	if got != "hashtag" {
		t.Errorf("got %q, want %q", got, "hashtag")
	}
}

func TestExtractTitle_H2NotMatched_FallsBackToFilename(t *testing.T) {
	got := ExtractTitle([]byte("## H2 Heading\nbody"), "notes/h2only.md")
	if got != "h2only" {
		t.Errorf("got %q, want %q", got, "h2only")
	}
}

func TestExtractTitle_LeadingBlankLines_StillFindsH1(t *testing.T) {
	got := ExtractTitle([]byte("\n\n# Tolerant Title\n\nbody"), "notes/tolerant.md")
	if got != "Tolerant Title" {
		t.Errorf("got %q, want %q", got, "Tolerant Title")
	}
}

func TestExtractTitle_FrontmatterUnclosed_FallsBackToFilename(t *testing.T) {
	content := "---\ntags: [a]\nstill-in-fm\n# would-be-title-but-stuck-in-frontmatter\n"
	got := ExtractTitle([]byte(content), "notes/unclosed.md")
	if got != "unclosed" {
		t.Errorf("got %q, want %q (unclosed frontmatter must fall through to filename)", got, "unclosed")
	}
}

func TestExtractTitle_TrailingWhitespaceTrimmed(t *testing.T) {
	got := ExtractTitle([]byte("#  Spaces Around   "), "notes/spaces.md")
	if got != "Spaces Around" {
		t.Errorf("got %q, want %q", got, "Spaces Around")
	}
}

func TestExtractTitle_FilenameFallback_BasePathStripped(t *testing.T) {
	got := ExtractTitle([]byte("body without heading"), "deep/nested/folder/leaf.md")
	if got != "leaf" {
		t.Errorf("got %q, want %q", got, "leaf")
	}
}
