package migrate

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
)

// BackupBeforeMigration copies dbPath -> backupPath using a temp+rename
// pattern. The destination is durable on disk before the function
// returns; a SIGKILL between any two steps leaves either the old backup
// intact or no backup at all — never a half-written backup.
//
// The in-memory ReadFile + fsstore.AtomicWrite path is the ONLY path;
// streaming backup is not implemented — dead code at this vault size.
//
// If dbPath does not exist (fresh data dir), BackupBeforeMigration is a
// no-op: there is nothing to back up. Returns nil.
func BackupBeforeMigration(dbPath, backupPath string) error {
	if _, err := os.Stat(dbPath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("backup stat: %w", err)
	}
	data, err := os.ReadFile(dbPath)
	if err != nil {
		return fmt.Errorf("backup read: %w", err)
	}

	if err := fsstore.AtomicWrite(backupPath, data); err != nil {
		return fmt.Errorf("backup write: %w", err)
	}
	return nil
}

// RestoreBackup overwrites dbPath with the contents of backupPath using
// the same atomic temp+rename pattern. Steps:
//
//  1. open backup for streaming read
//  2. CreateTemp in dbPath's directory
//  3. io.Copy + tmp.Sync()
//  4. rename tmp -> dbPath (atomic on POSIX)
//  5. fsync the parent directory
//
// SIGKILL between any two steps either keeps the previous app.db intact
// (rename has not happened yet) or installs the new one (rename has
// happened) — never partial.
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
