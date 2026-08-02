package fsstore

import (
	"fmt"
	"os"
	"path/filepath"
)

// AtomicWrite writes data to absPath durably and atomically, satisfying
// DATA-13: never truncate before confirming write success; the parent
// directory entry is fsynced so a crash after rename returns either the
// old content or the new content but never zero-byte / partial.
//
// The temp file lives in the SAME directory as absPath (not /tmp) so
// os.Rename is a true rename, never a cross-device fallback (EXDEV).
//
// Caller is responsible for ensuring the parent directory exists. We do
// NOT auto-mkdir because that hides real configuration bugs (e.g. a
// caller reaching into /var that must be created intentionally).
//
// Step order — each step is load-bearing; do not reorder:
//  1. os.CreateTemp in the SAME dir as the target (not TMPDIR).
//  2. Write all bytes, then file.Sync() to fsync the data.
//  3. file.Close().
//  4. os.Rename to the final path (atomic on POSIX).
//  5. Open the parent directory and Sync() it so the rename's directory-
//     entry change is durable across power loss. This is the most
//     commonly-skipped step.
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
