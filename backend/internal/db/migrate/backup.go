package migrate

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
)

// BackupBeforeMigration copies dbPath -> backupPath via temp+rename, so a
// SIGKILL between any two steps leaves the old backup intact or none at all —
// never a half-written one. No-op when dbPath does not exist.
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

// RestoreBackup overwrites dbPath from backupPath via the same temp+rename
// pattern: a SIGKILL either keeps the previous app.db or installs the new one,
// never a partial.
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
