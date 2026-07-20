//go:build !darwin && !linux

package index

import "io/fs"

// birthtimeFromPath is the fallback for platforms without a birthtime
// syscall wired up (or that this project does not target). D-04's
// fallback path (index's created_at) is always taken here.
func birthtimeFromPath(_ string, _ fs.FileInfo) (int64, bool) {
	return 0, false
}
