package markdown

import (
	"testing"
)

const testULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

// Golden cases: every byte outside the single id line must survive.
func TestWithID(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "no frontmatter gains the minimal block",
			input: "# Title\n\nbody\n",
			want:  "---\nid: " + testULID + "\n---\n# Title\n\nbody\n",
		},
		{
			name:  "empty content gains the minimal block",
			input: "",
			want:  "---\nid: " + testULID + "\n---\n",
		},
		{
			name:  "empty frontmatter",
			input: "---\n---\nbody\n",
			want:  "---\nid: " + testULID + "\n---\nbody\n",
		},
		{
			name:  "inserted as the first key, scaffold untouched",
			input: "---\ntags: []\n---\n\n# Title\n",
			want:  "---\nid: " + testULID + "\ntags: []\n---\n\n# Title\n",
		},
		{
			name:  "comments, quoting styles, key order and block lists are preserved",
			input: "---\n# leading comment\ntitle: 'single quoted'\nalias: \"double quoted\"   # trailing comment\ntags:\n  - one\n  -   two\nnested:\n    deep:   value\n---\nbody\n",
			want:  "---\nid: " + testULID + "\n# leading comment\ntitle: 'single quoted'\nalias: \"double quoted\"   # trailing comment\ntags:\n  - one\n  -   two\nnested:\n    deep:   value\n---\nbody\n",
		},
		{
			name:  "existing malformed id is replaced in place",
			input: "---\ntags: [a]\nid: not-an-id\ntitle: x\n---\nbody\n",
			want:  "---\ntags: [a]\nid: " + testULID + "\ntitle: x\n---\nbody\n",
		},
		{
			name:  "existing quoted id is replaced",
			input: "---\nid: \"00000000-0000-4000-a000-000000000001\"\n---\n",
			want:  "---\nid: " + testULID + "\n---\n",
		},
		{
			name:  "existing empty id is replaced",
			input: "---\nid:\ntags: []\n---\n",
			want:  "---\nid: " + testULID + "\ntags: []\n---\n",
		},
		{
			name:  "duplicate id lines collapse to one",
			input: "---\nid: a\ntags: []\nid: b\n---\n",
			want:  "---\nid: " + testULID + "\ntags: []\n---\n",
		},
		{
			name:  "nested id key is not the note id",
			input: "---\nmeta:\n  id: inner\n---\n",
			want:  "---\nid: " + testULID + "\nmeta:\n  id: inner\n---\n",
		},
		{
			name:  "id-prefixed key is not the id key",
			input: "---\nidentity: x\n---\n",
			want:  "---\nid: " + testULID + "\nidentity: x\n---\n",
		},
		{
			name:  "a horizontal rule in the body is not a fence",
			input: "---\ntags: []\n---\n\n----\n\n---\n",
			want:  "---\nid: " + testULID + "\ntags: []\n---\n\n----\n\n---\n",
		},
		{
			name:  "unclosed fence is body text",
			input: "---\ntags: []\nno close\n",
			want:  "---\nid: " + testULID + "\n---\n---\ntags: []\nno close\n",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := WithID([]byte(tc.input), testULID)
			if string(got) != tc.want {
				t.Errorf("WithID(%q)\n got: %q\nwant: %q", tc.input, got, tc.want)
			}
			if !HasFrontmatter(got) {
				t.Errorf("result has no frontmatter: %q", got)
			}
			if v, ok := ReadID(got); !ok || v != testULID {
				t.Errorf("ReadID(result) = %q, %v; want %q", v, ok, testULID)
			}
			if again := WithID(got, testULID); string(again) != string(got) {
				t.Errorf("WithID is not idempotent: %q", again)
			}
		})
	}
}

func TestWithID_AlreadyCorrectIsUnchanged(t *testing.T) {
	in := []byte("---\nid: " + testULID + "\ntags: []\n---\nbody\n")
	got := WithID(in, testULID)
	if &got[0] != &in[0] {
		t.Errorf("WithID copied content that already carried the id")
	}
}

func TestWithID_NormalizesCRLFFrontmatter(t *testing.T) {
	in := "---\r\ntags: []\r\n---\r\nbody\r\n"
	got := WithID([]byte(in), testULID)
	if want := "---\nid: " + testULID + "\ntags: []\n---\nbody\r\n"; string(got) != want {
		t.Errorf("WithID\n got: %q\nwant: %q", got, want)
	}
}

func TestNormalizeFrontmatterEOL(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"LF is untouched", "---\ntags: []\n---\nbody\r\n", "---\ntags: []\n---\nbody\r\n"},
		{"CRLF block, CRLF body", "---\r\ntags: []\r\n---\r\nbody\r\n", "---\ntags: []\n---\nbody\r\n"},
		{"closer at EOF", "---\r\ntags: []\r\n---", "---\ntags: []\n---"},
		{"unclosed is untouched", "---\r\ntags: []\r\nbody\r\n", "---\r\ntags: []\r\nbody\r\n"},
		{"four-hyphen closer is untouched", "---\r\ntags: []\r\n----\r\n", "---\r\ntags: []\r\n----\r\n"},
		{"no frontmatter", "# T\r\n", "# T\r\n"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizeFrontmatterEOL([]byte(tc.in)); string(got) != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestReadID(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
		found bool
	}{
		{"no frontmatter", "# T\n", "", false},
		{"no id key", "---\ntags: []\n---\n", "", false},
		{"plain", "---\nid: " + testULID + "\n---\n", testULID, true},
		{"not first key", "---\ntags: []\nid: " + testULID + "\n---\n", testULID, true},
		{"double quoted", "---\nid: \"" + testULID + "\"\n---\n", testULID, true},
		{"single quoted", "---\nid: '" + testULID + "'\n---\n", testULID, true},
		{"trailing comment", "---\nid: " + testULID + " # note\n---\n", testULID, true},
		{"tab separated", "---\nid:\t" + testULID + "\n---\n", testULID, true},
		{"empty value is found but empty", "---\nid:\n---\n", "", true},
		{"malformed value is returned as written", "---\nid: 1234\n---\n", "1234", true},
		{"first of duplicates wins", "---\nid: a\nid: b\n---\n", "a", true},
		{"nested key is ignored", "---\nmeta:\n  id: inner\n---\n", "", false},
		{"id-prefixed key is ignored", "---\nidentity: x\n---\n", "", false},
		{"CRLF block", "---\r\nid: " + testULID + "\r\n---\r\n", testULID, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, found := ReadID([]byte(tc.input))
			if got != tc.want || found != tc.found {
				t.Errorf("ReadID(%q) = %q, %v; want %q, %v", tc.input, got, found, tc.want, tc.found)
			}
		})
	}
}

// The tag rewriter re-serializes the whole block; the id line has to come
// out the other side intact, including an all-digit id YAML would otherwise
// read as a number.
func TestRewriteFrontmatterTags_PreservesIDLine(t *testing.T) {
	for _, id := range []string{testULID, "00000000000000000000000001"} {
		in := "---\nid: " + id + "\ntags: [a]\n---\nbody\n"
		out, err := RewriteFrontmatterTags([]byte(in), []string{"a", "b"})
		if err != nil {
			t.Fatalf("RewriteFrontmatterTags: %v", err)
		}
		got, ok := ReadID(out)
		if !ok || got != id {
			t.Errorf("id after tag rewrite = %q, %v; want %q\n%s", got, ok, id, out)
		}
		want := "---\nid: " + id + "\ntags: [a, b]\n---\nbody\n"
		if string(out) != want {
			t.Errorf("tag rewrite\n got: %q\nwant: %q", out, want)
		}
	}
}
