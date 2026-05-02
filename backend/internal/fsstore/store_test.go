package fsstore

import (
	"errors"
	"io/fs"
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
