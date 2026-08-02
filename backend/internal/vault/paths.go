// Package vault — paths.go is the single source of truth for per-vault path
// resolution.
//
// ".jasper" MUST NOT appear as a path literal in production code outside this
// file, with two exceptions: vault.AppHomePath and config.DefaultDataDir, which
// are app-home semantics (one per user) rather than per-vault (one per vault).
// The literal matches; the concepts do not. Do not fold them together.
//
// Helpers do NOT canonicalize and do no I/O — call sites gate paths upstream.
package vault

import "path/filepath"

// SubdirName is the canonical name for the per-vault data directory.
// All server-side state — SQLite index, config.json, logs, backup,
// seed-grants queue — lives under <vault>/SubdirName/.
const SubdirName = ".jasper"

// AppDBPath returns <root>/.jasper/app.db.
func AppDBPath(root string) string {
	return filepath.Join(root, SubdirName, "app.db")
}

// ConfigPath returns <root>/.jasper/config.json.
func ConfigPath(root string) string {
	return filepath.Join(root, SubdirName, "config.json")
}

// LogsDir returns <root>/.jasper/logs.
func LogsDir(root string) string {
	return filepath.Join(root, SubdirName, "logs")
}

// LogsPath returns <root>/.jasper/logs/jasper.log — the active log file the
// migration runner surfaces via MigrationStatus.LogsPath.
func LogsPath(root string) string {
	return filepath.Join(LogsDir(root), "jasper.log")
}

// BackupPath returns <root>/.jasper/app.db.backup — the migration runner's
// pre-migration snapshot. Defined as AppDBPath(root) + ".backup" so the
// suffix lives in exactly one place.
func BackupPath(root string) string {
	return AppDBPath(root) + ".backup"
}

// SeedGrantsPath returns <root>/.jasper/seed_grants.json — the queue file
// that firstrun.RunSetup writes and firstrun.ApplySeedGrants drains on the
// first server boot of a freshly-created vault.
func SeedGrantsPath(root string) string {
	return filepath.Join(root, SubdirName, "seed_grants.json")
}
