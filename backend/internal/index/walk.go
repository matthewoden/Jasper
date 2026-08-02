package index

import (
	"context"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
)

// FileMeta is the per-.md-file projection emitted by WalkVault.
//
// BirthtimeUnix is 0 when the platform cannot report one; that sentinel is
// resolved to created_at at query time, not here.
type FileMeta struct {
	CanonicalRelPath string
	AbsPath          string
	Size             int64
	MTimeUnix        int64
	BirthtimeUnix    int64
}

// WalkVault calls yield for every .md file under notesDir, skipping dotdirs and
// the reserved attachments/ subtree.
//
// A path that fails Canonicalize is skipped rather than aborting the walk — the
// indexer is best-effort and the next Reconcile retries.
//
// A non-nil yield error stops the walk and is returned unchanged, so callers can
// break out with a sentinel. notesDir MUST be absolute and MUST exist.
func WalkVault(ctx context.Context, notesDir string, yield func(FileMeta) error) error {
	return filepath.WalkDir(notesDir, func(path string, d fs.DirEntry, err error) error {
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if err != nil {
			if path == notesDir {
				return fmt.Errorf("walk %q: %w", notesDir, err)
			}

			return nil
		}
		if d.IsDir() {
			name := d.Name()

			if path != notesDir && strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}

			if path != notesDir && name == "attachments" {
				return filepath.SkipDir
			}
			return nil
		}

		if !strings.HasSuffix(strings.ToLower(d.Name()), ".md") {
			return nil
		}
		rel, err := filepath.Rel(notesDir, path)
		if err != nil {
			return nil
		}
		canonical, err := fsstore.Canonicalize(notesDir, rel)
		if err != nil {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		birthtimeUnix, _ := birthtimeFromPath(canonical, info)

		canonRel, err := filepath.Rel(notesDir, canonical)
		if err != nil {
			return nil
		}

		canonRel = filepath.ToSlash(canonRel)
		return yield(FileMeta{
			CanonicalRelPath: canonRel,
			AbsPath:          canonical,
			Size:             info.Size(),
			MTimeUnix:        info.ModTime().Unix(),
			BirthtimeUnix:    birthtimeUnix,
		})
	})
}
