package fsstore

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// Test S1: Read on a missing file returns an error wrapping fs.ErrNotExist
// so notes.Service can map it to notes.ErrNotFound.
func TestStore_Read_Missing(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	_, err := s.Read("scratchpad.md")
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected fs.ErrNotExist, got %v", err)
	}
}

// Test S2: WriteAtomic creates the file via Canonicalize+AtomicWrite;
// Read then returns the same bytes; Stat returns a non-zero mod time.
func TestStore_WriteAtomic_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.WriteAtomic("scratchpad.md", []byte("hi")); err != nil {
		t.Fatalf("WriteAtomic: %v", err)
	}
	got, err := s.Read("scratchpad.md")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(got) != "hi" {
		t.Fatalf("content: got %q, want %q", got, "hi")
	}
	mt, err := s.Stat("scratchpad.md")
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if mt.IsZero() {
		t.Fatalf("Stat returned zero ModTime")
	}
}

// Test S2b: case-insensitive Read finds a case-different write.
// Uses the SAME store (so canonicalization applies on both sides) so
// "Foo.md" and "foo.md" map to the same on-disk file.
func TestStore_WriteAtomic_CaseInsensitiveRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.WriteAtomic("Foo.md", []byte("hi")); err != nil {
		t.Fatalf("WriteAtomic: %v", err)
	}
	got, err := s.Read("foo.md")
	if err != nil {
		t.Fatalf("Read foo.md: %v", err)
	}
	if string(got) != "hi" {
		t.Fatalf("content: got %q, want %q", got, "hi")
	}
}

// Test S3: WriteAtomic of an escape path returns ErrPathEscape — proves
// Canonicalize is on the hot path for writes.
func TestStore_WriteAtomic_RejectsEscape(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	err := s.WriteAtomic("../escape.md", []byte("nope"))
	if !errors.Is(err, ErrPathEscape) {
		t.Fatalf("expected ErrPathEscape, got %v", err)
	}
}

// Test S3b: Read of an escape path returns ErrPathEscape — proves
// Canonicalize is also on the hot path for reads.
func TestStore_Read_RejectsEscape(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	_, err := s.Read("../etc/passwd")
	if !errors.Is(err, ErrPathEscape) {
		t.Fatalf("expected ErrPathEscape, got %v", err)
	}
}

// Test S4: WriteAtomic to a path under a not-yet-existing subdirectory
// returns an error (the caller is responsible for mkdir; Phase 1 only
// writes to the root).
func TestStore_WriteAtomic_NoAutoMkdir(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	err := s.WriteAtomic(filepath.Join("missing-dir", "note.md"), []byte("hi"))
	if err == nil {
		t.Fatalf("expected error, got nil — auto-mkdir is not part of the contract")
	}
}

// Test S5: Stat on a missing file returns fs.ErrNotExist (callers map
// this to notes.ErrNotFound).
func TestStore_Stat_Missing(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	_, err := s.Stat("scratchpad.md")
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected fs.ErrNotExist, got %v", err)
	}
}

// TestStore_CreateFile_DelegatesAndCanonicalizes: s.CreateFile("FOO.md")
// creates the file at <root>/foo.md (lowercase canonicalization applied).
func TestStore_CreateFile_DelegatesAndCanonicalizes(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.CreateFile("FOO.md"); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir, "foo.md")); err != nil {
		t.Fatalf("expected lowercase file, stat err = %v", err)
	}
}

// TestStore_DeleteDir_Recursive: populate a sub-tree via CreateDir +
// CreateFile, call s.DeleteDir(top, recursive=true), assert top is gone.
func TestStore_DeleteDir_Recursive(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.CreateDir("top"); err != nil {
		t.Fatalf("CreateDir top: %v", err)
	}
	if err := s.CreateDir(filepath.Join("top", "nested")); err != nil {
		t.Fatalf("CreateDir nested: %v", err)
	}
	if err := s.CreateFile(filepath.Join("top", "a.md")); err != nil {
		t.Fatalf("CreateFile a: %v", err)
	}
	if err := s.CreateFile(filepath.Join("top", "nested", "b.md")); err != nil {
		t.Fatalf("CreateFile b: %v", err)
	}
	if err := s.DeleteDir("top", true); err != nil {
		t.Fatalf("DeleteDir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "top")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("top should be gone, err = %v", err)
	}

	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("root should still exist: %v", err)
	}
}

// TestStore_MoveFile_PreservesContent: After s.WriteAtomic + s.MoveFile,
// s.Read at the new path returns the original bytes.
func TestStore_MoveFile_PreservesContent(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.WriteAtomic("a.md", []byte("payload")); err != nil {
		t.Fatalf("WriteAtomic: %v", err)
	}
	if err := s.MoveFile("a.md", "b.md"); err != nil {
		t.Fatalf("MoveFile: %v", err)
	}
	got, err := s.Read("b.md")
	if err != nil {
		t.Fatalf("Read b: %v", err)
	}
	if string(got) != "payload" {
		t.Fatalf("content: got %q, want %q", got, "payload")
	}
}

// TestStore_MoveDir_PreservesSubtree: After s.MoveDir, traversing the new
// path yields the same set of relative paths as the source had.
func TestStore_MoveDir_PreservesSubtree(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.CreateDir("src"); err != nil {
		t.Fatalf("CreateDir src: %v", err)
	}
	if err := s.CreateDir(filepath.Join("src", "inner")); err != nil {
		t.Fatalf("CreateDir inner: %v", err)
	}
	if err := s.WriteAtomic(filepath.Join("src", "a.md"), []byte("aa")); err != nil {
		t.Fatalf("write a: %v", err)
	}
	if err := s.WriteAtomic(filepath.Join("src", "inner", "b.md"), []byte("bb")); err != nil {
		t.Fatalf("write b: %v", err)
	}

	before := walkRel(t, filepath.Join(dir, "src"))

	if err := s.MoveDir("src", "dst"); err != nil {
		t.Fatalf("MoveDir: %v", err)
	}

	after := walkRel(t, filepath.Join(dir, "dst"))
	if len(before) != len(after) {
		t.Fatalf("subtree shape changed: before=%v after=%v", before, after)
	}
	for k, v := range before {
		if after[k] != v {
			t.Fatalf("subtree mismatch at %q: before %v / after %v", k, v, after[k])
		}
	}

	got, err := s.Read(filepath.Join("dst", "a.md"))
	if err != nil {
		t.Fatalf("Read moved a: %v", err)
	}
	if string(got) != "aa" {
		t.Fatalf("a content: got %q, want %q", got, "aa")
	}
}

func walkRel(t *testing.T, root string) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		out[rel] = info.IsDir()
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	return out
}
