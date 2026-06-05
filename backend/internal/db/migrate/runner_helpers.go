package migrate

import (
	"database/sql"
	"io/fs"
	"os"
)

func osStatPath(path string) (fs.FileInfo, error) {
	return os.Stat(path)
}

func isNotExistErr(err error) bool {
	return os.IsNotExist(err)
}

func backupFileExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.Mode().IsRegular()
}

func sqlNoRows() error {
	return sql.ErrNoRows
}
