package markdown

import (
	"errors"
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
			got, err := WithID([]byte(tc.input), testULID)
			if err != nil {
				t.Fatalf("WithID: %v", err)
			}
			if string(got) != tc.want {
				t.Errorf("WithID(%q)\n got: %q\nwant: %q", tc.input, got, tc.want)
			}
			if !HasFrontmatter(got) {
				t.Errorf("result has no frontmatter: %q", got)
			}
			if v, ok := ReadID(got); !ok || v != testULID {
				t.Errorf("ReadID(result) = %q, %v; want %q", v, ok, testULID)
			}
			again, err := WithID(got, testULID)
			if err != nil || string(again) != string(got) {
				t.Errorf("WithID is not idempotent: %q, %v", again, err)
			}
		})
	}
}

func TestWithID_AlreadyCorrectIsUnchanged(t *testing.T) {
	in := []byte("---\nid: " + testULID + "\ntags: []\n---\nbody\n")
	got, err := WithID(in, testULID)
	if err != nil {
		t.Fatal(err)
	}
	if &got[0] != &in[0] {
		t.Errorf("WithID copied content that already carried the id")
	}
}

func TestWithID_RefusesCRLF(t *testing.T) {
	in := "---\r\ntags: []\r\n---\r\nbody\r\n"
	got, err := WithID([]byte(in), testULID)
	if !errors.Is(err, ErrCRLFFrontmatter) {
		t.Fatalf("err = %v, want ErrCRLFFrontmatter", err)
	}
	if string(got) != in {
		t.Errorf("content changed on refusal: %q", got)
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
		{"CRLF is outside the contract", "---\r\nid: " + testULID + "\r\n---\r\n", "", false},
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
