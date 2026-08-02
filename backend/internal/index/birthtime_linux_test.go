package index

import (
	"os"
	"path/filepath"
	"testing"
)

// TestBirthtimeFromPath_FreshFile verifies birthtimeFromPath reports a real
// filesystem birthtime for a freshly created .md file on Linux/ext4 (CI
// ubuntu-latest). Some ext4 configurations or older kernels may
// not surface STATX_BTIME; when that happens the helper's contract is
// (0, false) — asserted explicitly here (not skipped) so this test stays
// deterministic regardless of the runner's filesystem (no-flaky-tests).
func TestBirthtimeFromPath_FreshFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")
	if err := os.WriteFile(path, []byte("# hello"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}

	btime, ok := birthtimeFromPath(path, info)
	if !ok {
		if btime != 0 {
			t.Errorf("expected btime=0 when ok=false (the fallback contract), got %d", btime)
		}
		return
	}
	if btime <= 0 {
		t.Errorf("expected positive btime when ok=true, got %d", btime)
	}
}

// TestBirthtimeFromPath_MissingFile verifies the helper reports (0, false)
// rather than erroring or panicking when the path does not exist (matches
// the zero-sentinel contract for any stat failure).
func TestBirthtimeFromPath_MissingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "does-not-exist.md")

	btime, ok := birthtimeFromPath(path, nil)
	if ok {
		t.Errorf("expected ok=false for missing file, got ok=true btime=%d", btime)
	}
	if btime != 0 {
		t.Errorf("expected btime=0 for missing file, got %d", btime)
	}
}
