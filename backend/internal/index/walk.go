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
//   - CanonicalRelPath is the filesystem-walked relative path under
//     notesDir, NFC-normalized + lowercased via fsstore.Canonicalize so
//     it matches the wire-format and database column convention.
//   - AbsPath is the resolved absolute path on disk (post-Canonicalize)
//     suitable for direct os.ReadFile / os.Stat.
//   - Size is the file size in bytes from fs.DirEntry.Info.
//   - MTimeUnix is the file mtime in UNIX seconds (change-detection signal;
//     checksum fallback is not implemented).
type FileMeta struct {
	CanonicalRelPath string
	AbsPath          string
	Size             int64
	MTimeUnix        int64
}

// WalkVault walks notesDir, calling yield for every .md file under it.
// Skip rules:
//
//   - Dotdirs (`.git`, `.obsidian`, etc.) are skipped via filepath.SkipDir.
//   - The reserved `attachments/` subtree is skipped — the indexer must
//     not index attachment metadata as notes.
//   - Non-`.md` files are silently skipped.
//   - A path that fails fsstore.Canonicalize (symlink escape, NFC error)
//     is skipped + best-effort logged by the caller; the walk does not
//     abort on a single bad path because the indexer is best-effort and
//     the next Reconcile re-tries.
//
// yield receives one FileMeta per `.md` file in lexicographic walk order.
// If yield returns a non-nil error, the walk stops and returns that
// error unchanged (callers can use a sentinel to break out early).
//
// notesDir MUST be absolute and MUST exist; a non-existent or
// non-readable notesDir surfaces as the underlying filepath.WalkDir
// error wrapped with the directory path.
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
		})
	})
}
