//go:build linux

package index

import (
	"io/fs"

	"golang.org/x/sys/unix"
)

// birthtimeFromPath returns (unixSeconds, true) when the filesystem reports
// a true creation time; (0, false) triggers the D-04 fallback to the
// index's created_at (first-seen-by-indexer).
//
// fs.FileInfo alone cannot report btime on Linux — the underlying
// syscall.Stat_t has no birthtime field on this platform (unlike darwin's
// Stat_t.Birthtimespec). A SEPARATE unix.Statx syscall with the
// STATX_BTIME mask is required (kernel 4.11+); info is unused here but
// kept for signature symmetry with the darwin variant.
func birthtimeFromPath(absPath string, _ fs.FileInfo) (int64, bool) {
	var stx unix.Statx_t
	if err := unix.Statx(unix.AT_FDCWD, absPath, unix.AT_STATX_SYNC_AS_STAT, unix.STATX_BTIME, &stx); err != nil {
		return 0, false
	}
	// The syscall can succeed without setting the BTIME bit — some
	// filesystems/kernels report "no error" yet cannot supply birthtime.
	// "No error" is NOT the same as "btime available" (Pitfall 2).
	if stx.Mask&unix.STATX_BTIME == 0 {
		return 0, false
	}
	return int64(stx.Btime.Sec), true
}
