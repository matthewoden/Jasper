// Package vault — paths.go is the single source of truth for per-vault path
// resolution. ADR-001 §6 names <vault>/.jasper/ as the canonical per-vault
// data directory; every server-side artifact (SQLite index, config.json,
// logs, backup, seed-grants queue) lives under that subdir.
//
// D-06 (Phase 9): the string ".jasper" MUST NOT appear as a path component
// literal in production code outside this file, with EXACTLY two documented
// exceptions:
//
//   - backend/internal/vault/types.go — vault.AppHomePath uses $HOME/.jasper
//     for the *app-level* registry (the directory that holds app.json).
//   - backend/internal/config/defaults.go — config.DefaultDataDir mirrors
//     that same app-home value.
//
// Both exceptions are app-home semantics (one per user); SubdirName here is
// per-vault semantics (one per vault). The string literal happens to match,
// but the concepts are distinct — do not fold them together. The Phase 9
// grep gate (Plan 03c) is calibrated to allow exactly those three files
// (paths.go, vault/types.go, config/defaults.go) and reject every other
// occurrence in production code.
//
// All helpers below accept a raw root string and return a pure string; they
// do NOT canonicalize the input (the call sites — cmd/jasper/serve.go,
// vault.Canonicalize — already gate paths upstream). Helpers perform no
// filesystem I/O.
package vault

import "path/filepath"

// SubdirName is the canonical name for the per-vault data directory
// (ADR-001 §6). All server-side state — SQLite index, config.json, logs,
// backup, seed-grants queue — lives under <vault>/SubdirName/.
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
// first server boot of a freshly-created vault (Phase 9 D-04).
func SeedGrantsPath(root string) string {
	return filepath.Join(root, SubdirName, "seed_grants.json")
}
