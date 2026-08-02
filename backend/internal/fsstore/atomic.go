package fsstore

import (
	"fmt"
	"os"
	"path/filepath"
)

// AtomicWrite never truncates before the write succeeds, so a crash returns the
// old content or the new — never zero-byte or partial.
//
// Do not reorder the steps. The temp file must live in the SAME directory as
// the target so os.Rename is a true rename and not a cross-device copy, and the
// parent directory must be fsynced AFTER the rename or the directory entry
// itself is not durable — the most commonly skipped step.
//
// Does NOT auto-mkdir: that hides real configuration bugs.
func AtomicWrite(absPath string, data []byte) error {
	dir := filepath.Dir(absPath)

	tmp, err := os.CreateTemp(dir, filepath.Base(absPath)+".tmp.*")
	if err != nil {
		return fmt.Errorf("atomic write: create temp: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("atomic write: write temp: %w", err)
	}

	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("atomic write: fsync temp: %w", err)
	}

	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("atomic write: close temp: %w", err)
	}

	if err := os.Rename(tmpName, absPath); err != nil {
		cleanup()
		return fmt.Errorf("atomic write: rename: %w", err)
	}

	dirf, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("atomic write: open parent dir for fsync: %w", err)
	}
	if err := dirf.Sync(); err != nil {
		_ = dirf.Close()
		return fmt.Errorf("atomic write: fsync parent dir: %w", err)
	}
	if err := dirf.Close(); err != nil {
		return fmt.Errorf("atomic write: close parent dir: %w", err)
	}
	return nil
}
