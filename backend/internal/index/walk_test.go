package index

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"golang.org/x/text/unicode/norm"
)

func collectWalk(t *testing.T, dir string) ([]string, error) {
	t.Helper()
	var got []string
	err := WalkVault(context.Background(), dir, func(fm FileMeta) error {
		got = append(got, fm.CanonicalRelPath)
		return nil
	})
	sort.Strings(got)
	return got, err
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestWalkVault_OnlyMarkdownFiles — yields .md files only; other
// extensions are silently skipped.
func TestWalkVault_OnlyMarkdownFiles(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.md"), "")
	writeFile(t, filepath.Join(dir, "b.txt"), "not a note")
	writeFile(t, filepath.Join(dir, "sub", "c.md"), "")
	writeFile(t, filepath.Join(dir, "sub", "d.png"), "")

	got, err := collectWalk(t, dir)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	want := []string{"a.md", "sub/c.md"}
	if len(got) != len(want) {
		t.Fatalf("len: got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d]: got %q, want %q", i, got[i], want[i])
		}
	}
}

// TestWalkVault_SkipsDotDirs — `.git`, `.obsidian` etc. are pruned
// completely (filepath.SkipDir).
func TestWalkVault_SkipsDotDirs(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "kept.md"), "")
	writeFile(t, filepath.Join(dir, ".git", "skipped.md"), "")
	writeFile(t, filepath.Join(dir, ".obsidian", "also-skipped.md"), "")

	got, err := collectWalk(t, dir)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(got) != 1 || got[0] != "kept.md" {
		t.Errorf("got %v, want [kept.md]", got)
	}
}

// TestWalkVault_SkipsAttachmentsDir — the indexer must not yield files
// from `attachments/` subtrees.
func TestWalkVault_SkipsAttachmentsDir(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "kept.md"), "")
	writeFile(t, filepath.Join(dir, "attachments", "image-note.md"), "")
	writeFile(t, filepath.Join(dir, "deeper", "attachments", "still-skipped.md"), "")

	got, err := collectWalk(t, dir)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(got) != 1 || got[0] != "kept.md" {
		t.Errorf("got %v, want [kept.md]", got)
	}
}

// TestWalkVault_NFC_Canonicalization — a path written with NFD-form
// (decomposed e + combining acute) yields the NFC form (precomposed é)
// because fsstore.Canonicalize normalizes.
func TestWalkVault_NFC_Canonicalization(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	nfd := norm.NFD.String("café.md")
	writeFile(t, filepath.Join(dir, nfd), "")

	got, err := collectWalk(t, dir)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %v, want 1 entry", got)
	}

	want := norm.NFC.String("café.md")
	if got[0] != want {
		t.Errorf("got %q (NFC bytes %x), want %q (NFC bytes %x)",
			got[0], []byte(got[0]), want, []byte(want))
	}
}

// TestWalkVault_Stops_OnYieldErr — yield returns a sentinel error;
// WalkVault returns that error unchanged so callers can break out.
func TestWalkVault_Stops_OnYieldErr(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.md"), "")
	writeFile(t, filepath.Join(dir, "b.md"), "")

	sentinel := errors.New("yield-stop sentinel")
	count := 0
	err := WalkVault(context.Background(), dir, func(_ FileMeta) error {
		count++
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("err: got %v, want %v", err, sentinel)
	}
	if count != 1 {
		t.Errorf("yield called %d times, want 1 (stopped at first)", count)
	}
}

// TestWalkVault_HandlesNonExistentDir — surfaces the underlying error
// wrapped with the path so callers can diagnose.
func TestWalkVault_HandlesNonExistentDir(t *testing.T) {
	t.Parallel()
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	err := WalkVault(context.Background(), missing, func(_ FileMeta) error { return nil })
	if err == nil {
		t.Fatalf("walk: got nil, want error for missing dir")
	}
	if !strings.Contains(err.Error(), missing) {
		t.Errorf("err message should mention path %q; got %v", missing, err)
	}
}

// TestWalkVault_MetaFields_Populated — yielded FileMeta has Size,
// MTimeUnix, AbsPath populated.
func TestWalkVault_MetaFields_Populated(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "x.md"), "hello world")

	var got FileMeta
	if err := WalkVault(context.Background(), dir, func(fm FileMeta) error {
		got = fm
		return nil
	}); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if got.CanonicalRelPath != "x.md" {
		t.Errorf("CanonicalRelPath: got %q, want %q", got.CanonicalRelPath, "x.md")
	}
	if got.Size != int64(len("hello world")) {
		t.Errorf("Size: got %d, want %d", got.Size, len("hello world"))
	}
	if got.MTimeUnix == 0 {
		t.Errorf("MTimeUnix: zero")
	}
	if !filepath.IsAbs(got.AbsPath) {
		t.Errorf("AbsPath: got %q, want absolute", got.AbsPath)
	}
}

// TestWalkVault_ContextCanceled — a canceled context aborts the walk.
func TestWalkVault_ContextCanceled(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	for i := 0; i < 50; i++ {
		writeFile(t, filepath.Join(dir, "n", "f"+itoa(i)+".md"), "")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := WalkVault(ctx, dir, func(_ FileMeta) error { return nil })
	if err == nil {
		t.Fatalf("walk: got nil, want context error")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err: got %v, want context.Canceled", err)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
