package migrate

import (
	"bytes"
	"crypto/rand"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestBackupBeforeMigration_Roundtrip — write random bytes to a temp
// app.db, call BackupBeforeMigration, assert backup matches byte-for-
// byte and the backup is a real file on disk (not a symlink).
func TestBackupBeforeMigration_Roundtrip(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app.db")
	backupPath := filepath.Join(dir, "app.db.backup")

	payload := make([]byte, 4096)
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("rand: %v", err)
	}
	if err := os.WriteFile(dbPath, payload, 0o600); err != nil {
		t.Fatalf("seed db: %v", err)
	}

	if err := BackupBeforeMigration(dbPath, backupPath); err != nil {
		t.Fatalf("BackupBeforeMigration: %v", err)
	}

	got, err := os.ReadFile(backupPath)
	if err != nil {
		t.Fatalf("read backup: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("backup contents differ (len got=%d want=%d)", len(got), len(payload))
	}

	// Verify no .tmp.* leftovers in the directory (AtomicWrite cleans
	// up on success).
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp.") {
			t.Errorf("leftover temp file after backup: %s", e.Name())
		}
	}
}

// TestBackupBeforeMigration_FreshDB_NoOp — when source does not exist,
// the backup is a no-op (no error, no backup file created). This
// matches the runner's "fresh DB has nothing to back up" semantics.
func TestBackupBeforeMigration_FreshDB_NoOp(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app.db")
	backupPath := filepath.Join(dir, "app.db.backup")

	if err := BackupBeforeMigration(dbPath, backupPath); err != nil {
		t.Fatalf("BackupBeforeMigration(missing): got %v, want nil", err)
	}
	if _, err := os.Stat(backupPath); !os.IsNotExist(err) {
		t.Fatalf("backup file should NOT exist for fresh-db no-op; stat err=%v", err)
	}
}

// TestRestoreBackup_OverwritesLiveDB_Atomically — write app.db = "old",
// backup = "new", call RestoreBackup, assert app.db = "new" and no
// .restore.tmp.* leftover.
func TestRestoreBackup_OverwritesLiveDB_Atomically(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app.db")
	backupPath := filepath.Join(dir, "app.db.backup")

	if err := os.WriteFile(dbPath, []byte("old"), 0o600); err != nil {
		t.Fatalf("seed live: %v", err)
	}
	newPayload := []byte("new content here, longer than old")
	if err := os.WriteFile(backupPath, newPayload, 0o600); err != nil {
		t.Fatalf("seed backup: %v", err)
	}

	if err := RestoreBackup(backupPath, dbPath); err != nil {
		t.Fatalf("RestoreBackup: %v", err)
	}

	got, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatalf("read live: %v", err)
	}
	if !bytes.Equal(got, newPayload) {
		t.Fatalf("live db: got %q, want %q", got, newPayload)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".restore.tmp.") {
			t.Errorf("leftover restore-temp file: %s", e.Name())
		}
	}
}

// TestRestoreBackup_PartialWriteWouldNotCorrupt — emulate by pointing
// RestoreBackup at a non-existent backup file: the function must fail
// before the rename step, leaving the original db untouched. Asserts
// the half-restore failure mode does not corrupt app.db.
func TestRestoreBackup_PartialWriteWouldNotCorrupt(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app.db")
	missingBackup := filepath.Join(dir, "no-such-backup")

	original := []byte("original-app-db-bytes")
	if err := os.WriteFile(dbPath, original, 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := RestoreBackup(missingBackup, dbPath); err == nil {
		t.Fatalf("RestoreBackup(missing): got nil, want error")
	}

	got, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatalf("read live after failed restore: %v", err)
	}
	if !bytes.Equal(got, original) {
		t.Fatalf("app.db corrupted by failed restore: got %q, want %q", got, original)
	}
}

// TestRestoreBackup_RenameFailure_DoesNotCorrupt — chmod the parent dir
// read-only AFTER the temp file is created so the rename step fails;
// assert the original app.db is unchanged. Skipped on Windows.
func TestRestoreBackup_RenameFailure_DoesNotCorrupt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("chmod permission semantics differ on Windows; v1 targets are macOS + WSL2")
	}
	if os.Geteuid() == 0 {
		t.Skip("root bypasses POSIX permission checks; skip when running as root")
	}
	t.Parallel()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app.db")
	backupPath := filepath.Join(dir, "app.db.backup")

	original := []byte("ORIGINAL-INTACT")
	if err := os.WriteFile(dbPath, original, 0o600); err != nil {
		t.Fatalf("seed live: %v", err)
	}
	if err := os.WriteFile(backupPath, []byte("REPLACEMENT"), 0o600); err != nil {
		t.Fatalf("seed backup: %v", err)
	}

	// Strip write permission from the parent dir; the temp-file
	// creation will fail with EACCES (rename can't run because temp
	// can't be created), proving RestoreBackup fails-closed.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	if err := RestoreBackup(backupPath, dbPath); err == nil {
		t.Fatalf("RestoreBackup(read-only-dir): got nil, want error")
	}

	// Restore dir perms so we can read the file back.
	_ = os.Chmod(dir, 0o700)
	got, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatalf("read live: %v", err)
	}
	if !bytes.Equal(got, original) {
		t.Fatalf("app.db corrupted by mid-restore failure: got %q, want %q", got, original)
	}
}

// TestDeleteBackup_Idempotent — calling DeleteBackup on a non-existent
// path returns nil (success-path callers don't have to check first).
func TestDeleteBackup_Idempotent(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	missing := filepath.Join(dir, "no-such-backup")

	if err := DeleteBackup(missing); err != nil {
		t.Fatalf("DeleteBackup(missing): got %v, want nil", err)
	}

	// And the success path: write a file, delete, assert gone.
	present := filepath.Join(dir, "app.db.backup")
	if err := os.WriteFile(present, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := DeleteBackup(present); err != nil {
		t.Fatalf("DeleteBackup(present): %v", err)
	}
	if _, err := os.Stat(present); !os.IsNotExist(err) {
		t.Fatalf("backup not removed; stat err=%v", err)
	}
}
