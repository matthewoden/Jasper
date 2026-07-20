//go:build darwin

package index

import (
	"io/fs"
	"syscall"
)

// birthtimeFromPath returns (unixSeconds, true) when the filesystem reports
// a true creation time; (0, false) triggers the D-04 fallback to the
// index's created_at (first-seen-by-indexer). On darwin, birthtime comes
// directly from the fs.FileInfo already captured by the caller — absPath
// is unused here (kept for signature symmetry with the linux variant,
// which needs a second syscall against the path).
func birthtimeFromPath(_ string, info fs.FileInfo) (int64, bool) {
	if info == nil {
		return 0, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return stat.Birthtimespec.Sec, true
}
