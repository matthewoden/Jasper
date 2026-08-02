// Package migrate implements the migration runner with the three-path
// resilience strategy: Path 1 atomic backup-restore on a failed
// migration, Path 2 drop-and-rebuild + full re-index (admin/reindex),
// Path 3 unrecoverable halt.
//
// This file owns the disk-space pre-flight: every Run starts by
// verifying the data volume has at least 2× the current app.db size in
// free bytes; if not, Run aborts with a wrapped ErrDiskFull and the
// composition root serves the static disk-full.html page.
package migrate

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// ErrDiskFull is returned by PreflightFreeSpace when the data volume has
// less than 2× the current app.db size in free bytes. Callers surface
// this verbatim in the static disk-full.html error page so the user can
// free space and retry.
//
// Always wrapped via fmt.Errorf("%w: ...") so callers detect with
// errors.Is(err, ErrDiskFull).
var ErrDiskFull = errors.New("migrate: insufficient free disk space for safe migration")

// PreflightFreeSpace requires free >= 2× size(dbPath): the backup is a full
// copy, and the migration may grow the live db on top of that.
//
// A missing dbPath needs 0 — nothing to back up — so the runner applies
// 001_initial.sql with no backup, and a failure there is unrecoverable.
func PreflightFreeSpace(dbPath string) error {
	info, err := os.Stat(dbPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
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

var freeBytes = func(path string) (uint64, error) {
	if os.Getenv("JASPER_TEST_FORCE_DISK_FULL") == "1" {
		return 0, nil
	}

	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}

	return uint64(stat.Bavail) * uint64(stat.Bsize), nil
}
