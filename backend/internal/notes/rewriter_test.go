package notes

import (
	"testing"
)

// T1: basic rename in flow sequence.
func TestRewriteTagsArray_T1_BasicRename(t *testing.T) {
	in := []byte("---\ntags: [foo, bar]\n---\nbody")
	got := rewriteTagsArray(in, "foo", "feature")
	s := string(got)
	if !strContains(s, "feature") {
		t.Errorf("T1: expected 'feature' in output; got: %q", s)
	}
	if strContains(s, "foo") {
		t.Errorf("T1: 'foo' should be replaced; got: %q", s)
	}
	if !strContains(s, "bar") {
		t.Errorf("T1: 'bar' should be preserved; got: %q", s)
	}
	if !strContains(s, "body") {
		t.Errorf("T1: body text should be preserved; got: %q", s)
	}
}

// T2: block sequence frontmatter (- foo / - bar style); renamed entry preserved.
func TestRewriteTagsArray_T2_BlockSequence(t *testing.T) {
	in := []byte("---\ntags:\n  - foo\n  - bar\n---\n")
	got := rewriteTagsArray(in, "foo", "feature")
	s := string(got)
	if !strContains(s, "feature") {
		t.Errorf("T2: expected 'feature' in output; got: %q", s)
	}
	if !strContains(s, "bar") {
		t.Errorf("T2: 'bar' should survive the rename; got: %q", s)
	}
}

// T3: no frontmatter → return unchanged.
func TestRewriteTagsArray_T3_NoFrontmatter(t *testing.T) {
	in := []byte("# Just a Heading\n\nbody without frontmatter")
	got := rewriteTagsArray(in, "foo", "feature")
	if string(got) != string(in) {
		t.Errorf("T3: content without frontmatter should be returned unchanged; got: %q", got)
	}
}

// T4: oldName not in tags → return unchanged.
func TestRewriteTagsArray_T4_OldNameNotFound(t *testing.T) {
	in := []byte("---\ntags: [bar, baz]\n---\nbody")
	got := rewriteTagsArray(in, "foo", "feature")
	if string(got) != string(in) {
		t.Errorf("T4: tag not found should return input unchanged; got: %q", got)
	}
}

// T5: delete path (newName == "" → remove entry).
func TestRewriteTagsArray_T5_Delete(t *testing.T) {
	in := []byte("---\ntags: [foo, bar]\n---\nbody")
	got := rewriteTagsArray(in, "foo", "")
	s := string(got)
	if strContains(s, "foo") {
		t.Errorf("T5: 'foo' should be removed; got: %q", s)
	}
	if !strContains(s, "bar") {
		t.Errorf("T5: 'bar' should survive; got: %q", s)
	}
}

// T6: remove the last tag → tags: [] (NOT removal of key).
func TestRewriteTagsArray_T6_DeleteLastTag(t *testing.T) {
	in := []byte("---\ntags: [foo]\n---\nbody")
	got := rewriteTagsArray(in, "foo", "")
	s := string(got)
	if strContains(s, "foo") {
		t.Errorf("T6: 'foo' should be removed; got: %q", s)
	}
	if !strContains(s, "tags") {
		t.Errorf("T6: 'tags' key should remain; got: %q", s)
	}

	if !strContains(s, "---") {
		t.Errorf("T6: frontmatter fences should remain; got: %q", s)
	}
}

// T7: tag appears in another YAML key (title: foo) → only tags array is touched.
func TestRewriteTagsArray_T7_OnlyTagsArray(t *testing.T) {
	in := []byte("---\ntitle: foo\ntags: [foo, bar]\n---\nbody")
	got := rewriteTagsArray(in, "foo", "feature")
	s := string(got)
	if !strContains(s, "title: foo") {
		t.Errorf("T7: 'title: foo' should be preserved; got: %q", s)
	}
	if !strContains(s, "feature") {
		t.Errorf("T7: 'feature' should appear in tags; got: %q", s)
	}
}

// W1: basic rename + aliased rewrite.
func TestRewriteWikilinksAST_W1_BasicAndAlias(t *testing.T) {
	in := []byte("see [[Foo]] and [[Foo|alias]] and [[Bar]]")
	got := RewriteWikilinksAST(in, "Foo", "Baz")
	s := string(got)

	if !strContains(s, "[[Baz]]") {
		t.Errorf("W1: expected '[[Baz]]'; got: %q", s)
	}

	if !strContains(s, "[[Baz|alias]]") {
		t.Errorf("W1: expected '[[Baz|alias]]'; got: %q", s)
	}

	if !strContains(s, "[[Bar]]") {
		t.Errorf("W1: '[[Bar]]' should be preserved; got: %q", s)
	}

	if strContains(s, "[[Foo]]") {
		t.Errorf("W1: '[[Foo]]' should be replaced; got: %q", s)
	}
}

// W2: fenced code block — occurrence inside fence stays literal (D-19).
func TestRewriteWikilinksAST_W2_FencedCodeBlock(t *testing.T) {
	in := []byte("```\n[[Foo]] inside code\n```\n[[Foo]] outside")
	got := RewriteWikilinksAST(in, "Foo", "Baz")
	s := string(got)

	if !strContains(s, "[[Foo]] inside code") {
		t.Errorf("W2: fenced reference should be preserved; got: %q", s)
	}

	if !strContains(s, "[[Baz]] outside") {
		t.Errorf("W2: reference outside code block should be replaced; got: %q", s)
	}
}

// W3: inline code span — occurrence inside backtick span stays literal.
func TestRewriteWikilinksAST_W3_InlineCodeSpan(t *testing.T) {
	in := []byte("see `[[Foo]]` inline and [[Foo]] outside")
	got := RewriteWikilinksAST(in, "Foo", "Baz")
	s := string(got)

	if !strContains(s, "`[[Foo]]`") {
		t.Errorf("W3: inline code reference should be preserved; got: %q", s)
	}

	if !strContains(s, "[[Baz]] outside") {
		t.Errorf("W3: reference outside code span should be replaced; got: %q", s)
	}
}

// W4: no matching references → return input unchanged.
func TestRewriteWikilinksAST_W4_NoMatch(t *testing.T) {
	in := []byte("see [[Bar]] and [[Baz]]")
	got := RewriteWikilinksAST(in, "Foo", "Qux")
	if string(got) != string(in) {
		t.Errorf("W4: no match should return input unchanged; got: %q", got)
	}
}

// W5: case-insensitive matching.
func TestRewriteWikilinksAST_W5_CaseInsensitive(t *testing.T) {
	in := []byte("see [[FOO]] and [[Foo]] and [[foo]]")
	got := RewriteWikilinksAST(in, "foo", "Bar")
	s := string(got)

	if strContains(s, "[[FOO]]") || strContains(s, "[[Foo]]") || strContains(s, "[[foo]]") {
		t.Errorf("W5: all case variants should be replaced; got: %q", s)
	}

	count := countOccurrences(s, "[[Bar]]")
	if count != 3 {
		t.Errorf("W5: expected 3 [[Bar]] occurrences, got %d; output: %q", count, s)
	}
}

// W6: multi-occurrence rewrite produces no overlap or truncation.
func TestRewriteWikilinksAST_W6_MultiOccurrence(t *testing.T) {
	in := []byte("a [[Foo]] b [[Foo]] c [[Foo]] d")
	got := RewriteWikilinksAST(in, "Foo", "LongNewTitle")
	s := string(got)
	if strContains(s, "[[Foo]]") {
		t.Errorf("W6: all [[Foo]] should be replaced; got: %q", s)
	}
	count := countOccurrences(s, "[[LongNewTitle]]")
	if count != 3 {
		t.Errorf("W6: expected 3 [[LongNewTitle]] occurrences, got %d; output: %q", count, s)
	}

	if !strContains(s, "a ") || !strContains(s, " b ") || !strContains(s, " c ") || !strContains(s, " d") {
		t.Errorf("W6: surrounding text corrupted; got: %q", s)
	}
}

func strContains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || strIndex(s, sub) >= 0)
}

func strIndex(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func countOccurrences(s, sub string) int {
	count := 0
	for i := 0; i+len(sub) <= len(s); {
		if s[i:i+len(sub)] == sub {
			count++
			i += len(sub)
		} else {
			i++
		}
	}
	return count
}
