// Package migrate implements the Phase 2 migration runner with the
// three-path resilience strategy (DESIGN.md §4.4): Path 1 atomic
// backup-restore on a failed migration, Path 2 drop-and-rebuild +
// full re-index (admin/reindex), Path 3 unrecoverable halt.
//
// This file owns the disk-space pre-flight (DATA-07): every Run starts
// by verifying the data volume has at least 2× the current app.db size
// in free bytes; if not, Run aborts with a wrapped ErrDiskFull and the
// composition root (Plan 02-06) serves the static disk-full.html page.
package migrate

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// ErrDiskFull is returned by PreflightFreeSpace when the data volume has
// less than 2× the current app.db size in free bytes (DATA-07). Callers
// surface this verbatim in the static disk-full.html error page so the
// user can free space and retry.
//
// Always wrapped via fmt.Errorf("%w: ...") so callers detect with
// errors.Is(err, ErrDiskFull).
var ErrDiskFull = errors.New("migrate: insufficient free disk space for safe migration")

// PreflightFreeSpace verifies free space on the volume containing dbPath.
//
// Returns:
//   - nil if free >= 2 * size(dbPath)
//   - ErrDiskFull (wrapped, with required/available numbers in the
//     message) if free < 2 * size(dbPath)
//   - any IO error from Stat/Statfs otherwise
//
// If dbPath does not exist (fresh data dir), the free-space requirement
// is 0 — there is nothing to back up — and PreflightFreeSpace returns
// nil. The runner then proceeds to apply 001_initial.sql with no backup
// step (Path 3 if it fails because there is nothing to restore).
//
// The 2× heuristic comes from DESIGN.md §4.4: the backup file is a full
// copy of app.db, plus the migration may grow the live db (e.g. an
// index rebuild), so 2× is the floor.
//
// SECURITY-05 / single-user self-host means we don't worry about the
// disk being shared with hostile users between the check and the write
// — the user owns their machine.
func PreflightFreeSpace(dbPath string) error {
	info, err := os.Stat(dbPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // fresh DB; nothing to back up
		}
		return fmt.Errorf("preflight stat %q: %w", dbPath, err)
	}
	currentSize := uint64(info.Size())
	free, err := freeBytes(dbPath)
	if err != nil {
		return fmt.Errorf("preflight statfs %q: %w", dbPath, err)
	}
	required := 2 * currentSize
	if free < required {
		return fmt.Errorf(
			"%w: need %d bytes free, have %d (db size %d, required 2x = %d)",
			ErrDiskFull, required, free, currentSize, required,
		)
	}
	return nil
}

// freeBytes returns the available disk space on the volume containing
// path. Implementation uses syscall.Statfs which is supported on macOS,
// Linux, and WSL2 — Windows-native is not v1 (PROJECT.md).
//
// Declared as a package-level variable so tests can swap in a mock
// without modifying production code paths. Production callers (the
// Runner) reach freeBytes through PreflightFreeSpace.
//
// BLOCKER 3 (Plan 02-03) — the smoke test in Plan 02-06 forces a
// disk-full condition from outside the process by setting
// JASPER_TEST_FORCE_DISK_FULL=1 before launching the server binary.
// The env-var guard at the top of this function returns "0 bytes free"
// so the runner's pre-flight aborts with ErrDiskFull. Production
// deployments don't set this env var, so the guard is a no-op there.
// See Plan 02-06 Task 3 + threat T-02-03-04 / T-02-06-01.
var freeBytes = func(path string) (uint64, error) {
	// Test hook: forcing disk-full from outside the process (used by the
	// smoke test in Plan 02-06 — JASPER_TEST_FORCE_DISK_FULL=1).
	// Production deployments don't set this var so the guard is a no-op.
	if os.Getenv("JASPER_TEST_FORCE_DISK_FULL") == "1" {
		return 0, nil
	}
	// Default: real-syscall path.
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	// Statfs.Bavail is "blocks available to non-superuser"; multiply by
	// block size to get bytes. Bsize is int32 on Darwin / int64 on Linux
	// — cast both sides to uint64 to avoid overflow on Linux.
	return uint64(stat.Bavail) * uint64(stat.Bsize), nil
}
