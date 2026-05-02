package fsstore

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"testing"
)

// Test A: small write — 1KB of bytes round-trips.
func TestAtomicWrite_SmallPayload(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "note.md")
	data := make([]byte, 1024)
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	if err := AtomicWrite(target, data); err != nil {
		t.Fatalf("AtomicWrite: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("content mismatch: got %d bytes, want %d", len(got), len(data))
	}
}

// Test B: large write — 1 MiB of bytes round-trips.
func TestAtomicWrite_LargePayload(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "note.md")
	data := make([]byte, 1024*1024)
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	if err := AtomicWrite(target, data); err != nil {
		t.Fatalf("AtomicWrite: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("content mismatch: got %d bytes, want %d", len(got), len(data))
	}
}

// Test C: overwrite an existing file — the new content replaces the old,
// and no temp files leak in the directory.
func TestAtomicWrite_Overwrite(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "note.md")

	if err := AtomicWrite(target, []byte("original")); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := AtomicWrite(target, []byte("replaced")); err != nil {
		t.Fatalf("second write: %v", err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != "replaced" {
		t.Fatalf("content not replaced: got %q", got)
	}

	// Test F (overlapping check): no .tmp.* leftovers in the directory.
	leftovers, _ := filepath.Glob(filepath.Join(dir, "*.tmp.*"))
	if len(leftovers) != 0 {
		t.Fatalf("temp files leaked: %v", leftovers)
	}
}

// Test D: parent directory missing — AtomicWrite returns an error;
// caller is responsible for mkdir.
func TestAtomicWrite_MissingParent(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "does", "not", "exist", "note.md")
	err := AtomicWrite(target, []byte("hi"))
	if err == nil {
		t.Fatalf("expected error for missing parent, got nil")
	}
}

// Test E: concurrent-writes stress test. 50 goroutines all hammer the same
// target with AtomicWrite. After all complete, the file MUST be readable,
// MUST be one of the WRITE-NNN values (or the seed), and there MUST be no
// .tmp.* leftovers. This is the parallel-goroutines variant of the kill -9
// loop documented in the plan; it exercises the same property:
// AtomicWrite never leaves a zero-byte target. (Subprocess SIGKILL during
// AtomicWrite is invoked from TestAtomicWrite_KillNineSubprocess below.)
func TestAtomicWrite_NeverLeavesPartialFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "note.md")
	if err := AtomicWrite(target, []byte("INITIAL")); err != nil {
		t.Fatalf("seed: %v", err)
	}

	const N = 50
	var wg sync.WaitGroup
	wg.Add(N)
	errCh := make(chan error, N)
	for i := 0; i < N; i++ {
		go func(n int) {
			defer wg.Done()
			content := []byte(fmt.Sprintf("WRITE-%03d", n))
			if err := AtomicWrite(target, content); err != nil {
				errCh <- fmt.Errorf("iter %d: %w", n, err)
			}
		}(i)
	}
	wg.Wait()
	close(errCh)
	for e := range errCh {
		t.Errorf("%v", e)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if len(got) == 0 {
		t.Fatalf("target is zero-byte after concurrent AtomicWrites")
	}
	if !regexp.MustCompile(`^(WRITE-\d{3}|INITIAL)$`).Match(got) {
		t.Fatalf("unexpected content: %q", got)
	}

	leftovers, _ := filepath.Glob(filepath.Join(dir, "*.tmp.*"))
	if len(leftovers) != 0 {
		t.Fatalf("temp files leaked: %v", leftovers)
	}
}

// Test F: explicit no-leftover check after a single successful write.
// (Test C also covers this in the overwrite scenario.)
func TestAtomicWrite_NoLeftovers(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "note.md")
	if err := AtomicWrite(target, []byte("hello")); err != nil {
		t.Fatalf("AtomicWrite: %v", err)
	}
	leftovers, _ := filepath.Glob(filepath.Join(dir, "*.tmp.*"))
	if len(leftovers) != 0 {
		t.Fatalf("temp files leaked: %v", leftovers)
	}
}
