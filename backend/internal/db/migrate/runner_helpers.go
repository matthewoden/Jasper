package migrate

import (
	"database/sql"
	"io/fs"
	"os"
)

// osStatPath wraps os.Stat so the runner can call into it without
// importing "os" in runner.go (which keeps that file's import block
// focused on the orchestration logic).
func osStatPath(path string) (fs.FileInfo, error) {
	return os.Stat(path)
}

// isNotExistErr is the canonical "file does not exist" check.
func isNotExistErr(err error) bool {
	return os.IsNotExist(err)
}

// backupFileExists reports whether a regular file is present at path.
// Used by Path 1 to distinguish "no backup taken (fresh DB)" from
// "backup taken successfully" — the former forces Path 3.
func backupFileExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.Mode().IsRegular()
}

// sqlNoRows returns sql.ErrNoRows so callers in runner.go don't have to
// import "database/sql" just for one sentinel comparison. Keeps the
// package's runtime imports minimal.
func sqlNoRows() error {
	return sql.ErrNoRows
}
