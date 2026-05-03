package migrate

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
)

// BackupBeforeMigration copies dbPath -> backupPath using a temp+rename
// pattern (DATA-08). The destination is durable on disk before the
// function returns; a SIGKILL between any two steps leaves either the
// old backup intact or no backup at all — never a half-written backup.
//
// Phase 2's app.db is bounded: a 5,000-note vault produces an index
// well under 50 MiB; the in-memory ReadFile + fsstore.AtomicWrite path
// is the ONLY path. Streaming-backup is intentionally NOT implemented
// here — it would be dead code in Phase 2 and complicates the audit
// surface for DATA-08 (one path, one pattern, fsstore.AtomicWrite is
// the audited primitive).
//
// Streaming backup deferred to Phase 7 (attachments) when single-file
// size could exceed the memory budget.
//
// If dbPath does not exist (fresh data dir), BackupBeforeMigration is a
// no-op: there is nothing to back up. Returns nil.
func BackupBeforeMigration(dbPath, backupPath string) error {
	if _, err := os.Stat(dbPath); err != nil {
		if os.IsNotExist(err) {
			return nil // nothing to back up; fresh DB
		}
		return fmt.Errorf("backup stat: %w", err)
	}
	data, err := os.ReadFile(dbPath)
	if err != nil {
		return fmt.Errorf("backup read: %w", err)
	}
	// Caller is responsible for ensuring backupPath's parent directory
	// exists; the runner's composition root (Plan 02-06) mkdirs the
	// storage root before opening the DB pair.
	if err := fsstore.AtomicWrite(backupPath, data); err != nil {
		return fmt.Errorf("backup write: %w", err)
	}
	return nil
}

// RestoreBackup overwrites dbPath with the contents of backupPath using
// the same atomic temp+rename pattern. The five steps mirror
// fsstore.AtomicWrite but stream the bytes from the backup file
// directly so restore does not need to load the entire .db into memory:
//
//  1. open backup for streaming read
//  2. CreateTemp in dbPath's directory
//  3. io.Copy + tmp.Sync()
//  4. rename tmp -> dbPath (atomic on POSIX)
//  5. fsync the parent directory
//
// SIGKILL between any two steps either keeps the previous app.db intact
// (rename has not happened yet) or installs the new one (rename has
// happened) — never partial. Tested by
// TestRestoreBackup_OverwritesLiveDB_Atomically.
func RestoreBackup(backupPath, dbPath string) error {
	bf, err := os.Open(backupPath)
	if err != nil {
		return fmt.Errorf("restore open backup: %w", err)
	}
	defer func() { _ = bf.Close() }()

	dir := filepath.Dir(dbPath)
	tmp, err := os.CreateTemp(dir, filepath.Base(dbPath)+".restore.tmp.*")
	if err != nil {
		return fmt.Errorf("restore create temp: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }

	if _, err := io.Copy(tmp, bf); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("restore copy: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("restore fsync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("restore close: %w", err)
	}
	if err := os.Rename(tmpName, dbPath); err != nil {
		cleanup()
		return fmt.Errorf("restore rename: %w", err)
	}
	// fsync the parent directory so the rename's directory-entry change
	// is durable across power loss. Skipping this step is the most-
	// common atomicity bug.
	dirf, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("restore open parent: %w", err)
	}
	if err := dirf.Sync(); err != nil {
		_ = dirf.Close()
		return fmt.Errorf("restore fsync parent: %w", err)
	}
	if err := dirf.Close(); err != nil {
		return fmt.Errorf("restore close parent: %w", err)
	}
	return nil
}

// DeleteBackup removes backupPath. Missing-file errors are swallowed
// because the success path also calls this and a missing backup just
// means we never created one (fresh DB).
func DeleteBackup(backupPath string) error {
	err := os.Remove(backupPath)
	if err == nil || os.IsNotExist(err) {
		return nil
	}
	return fmt.Errorf("delete backup: %w", err)
}
