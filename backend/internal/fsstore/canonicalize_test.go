package fsstore

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func resolved(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", p, err)
	}
	return r
}

func TestCanonicalize_LowercasesMixedCase(t *testing.T) {
	root := t.TempDir()
	got, err := Canonicalize(root, "Foo.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := filepath.Join(root, "foo.md")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestCanonicalize_CaseEquivalence(t *testing.T) {
	root := t.TempDir()
	a, err := Canonicalize(root, "FOO.md")
	if err != nil {
		t.Fatalf("FOO.md: %v", err)
	}
	b, err := Canonicalize(root, "foo.md")
	if err != nil {
		t.Fatalf("foo.md: %v", err)
	}
	if a != b {
		t.Fatalf("case-different inputs canonicalize differently: %q vs %q", a, b)
	}
}

// "café.md" with U+0301 combining acute (NFD) vs U+00E9 precomposed é (NFC)
// must collapse to identical bytes after Canonicalize.
func TestCanonicalize_NFDvsNFCEquivalence(t *testing.T) {
	root := t.TempDir()

	nfd := "café.md"

	nfc := "café.md"
	if nfd == nfc {
		t.Fatalf("test inputs are byte-equal; setup error")
	}
	a, err := Canonicalize(root, nfd)
	if err != nil {
		t.Fatalf("NFD: %v", err)
	}
	b, err := Canonicalize(root, nfc)
	if err != nil {
		t.Fatalf("NFC: %v", err)
	}
	if a != b {
		t.Fatalf("NFD and NFC canonicalize differently: %q vs %q", a, b)
	}
}

func TestCanonicalize_RejectsParentEscape(t *testing.T) {
	root := t.TempDir()
	_, err := Canonicalize(root, "../escape.md")
	if !errors.Is(err, ErrPathEscape) {
		t.Fatalf("expected ErrPathEscape, got %v", err)
	}
}

func TestCanonicalize_RejectsAbsolutePath(t *testing.T) {
	root := t.TempDir()
	_, err := Canonicalize(root, "/absolute/path.md")
	if !errors.Is(err, ErrAbsolutePath) {
		t.Fatalf("expected ErrAbsolutePath, got %v", err)
	}
}

func TestCanonicalize_RejectsCleanedEscape(t *testing.T) {
	root := t.TempDir()
	_, err := Canonicalize(root, "valid/../../escape.md")
	if !errors.Is(err, ErrPathEscape) {
		t.Fatalf("expected ErrPathEscape, got %v", err)
	}
}

func TestCanonicalize_PreservesSubdir(t *testing.T) {
	root := t.TempDir()
	got, err := Canonicalize(root, "subdir/Note.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := filepath.Join(root, "subdir", "note.md")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestCanonicalize_RejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()

	if err := os.Symlink(outside, filepath.Join(root, "evil")); err != nil {
		t.Skipf("symlink unsupported on this platform: %v", err)
	}
	_, err := Canonicalize(root, "evil/passwd")
	if !errors.Is(err, ErrNotInRoot) {
		t.Fatalf("expected ErrNotInRoot, got %v", err)
	}
}

func TestCanonicalize_RejectsEmpty(t *testing.T) {
	root := t.TempDir()
	_, err := Canonicalize(root, "")
	if !errors.Is(err, ErrEmptyPath) {
		t.Fatalf("expected ErrEmptyPath, got %v", err)
	}
}

func TestCanonicalize_PreservesSpaces(t *testing.T) {
	root := t.TempDir()
	got, err := Canonicalize(root, "Note With Spaces.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := filepath.Join(root, "note with spaces.md")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// Sanity test: the documented behavior for a current-dir-only "." input
// is empty-path rejection. This guards against accidentally canonicalizing
// "." to the root itself, which would let a writer overwrite the root dir.
func TestCanonicalize_RejectsDotPath(t *testing.T) {
	root := t.TempDir()
	_, err := Canonicalize(root, ".")
	if err == nil {
		t.Fatalf("expected error for \".\" input")
	}
}

// Sanity: errors round-trip through fmt.Errorf wrapping (callers in
// fsstore.Store wrap the error with %w; this confirms the sentinels are
// detectable by errors.Is even after wrapping).
func TestCanonicalize_SentinelWrapping(t *testing.T) {
	root := t.TempDir()
	_, err := Canonicalize(root, "../x.md")
	if err == nil {
		t.Fatalf("expected error")
	}
	wrapped := wrap(err, "outer")
	if !errors.Is(wrapped, ErrPathEscape) {
		t.Fatalf("ErrPathEscape lost across wrapping; got %v", wrapped)
	}
}

func wrap(err error, prefix string) error {
	if err == nil {
		return nil
	}
	return &wrappedErr{prefix: prefix, err: err}
}

type wrappedErr struct {
	prefix string
	err    error
}

func (w *wrappedErr) Error() string { return w.prefix + ": " + w.err.Error() }
func (w *wrappedErr) Unwrap() error { return w.err }

// Sanity: confirm filepath.Separator is the byte we expected — guards
// against this test's HasPrefix check working only on macOS/Linux but
// not on Windows (Windows paths not yet supported).
func TestCanonicalize_PathSeparatorAssumption(t *testing.T) {
	if !strings.ContainsRune("/\\", rune(filepath.Separator)) {
		t.Fatalf("unexpected filepath.Separator: %q", filepath.Separator)
	}
}

// Sanity: a path that resolves cleanly to within the root works even
// when the leaf file does not yet exist. AtomicWrite relies on this —
// it's called before the target file has been created.
func TestCanonicalize_AcceptsNonExistentTarget(t *testing.T) {
	root := t.TempDir()
	got, err := Canonicalize(root, "brand-new-file.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	wantUnderlying := filepath.Join(resolved(t, root), "brand-new-file.md")
	if resolved(t, filepath.Dir(got))+string(filepath.Separator)+filepath.Base(got) != wantUnderlying {
		t.Fatalf("got %q, want under %q", got, wantUnderlying)
	}
}
