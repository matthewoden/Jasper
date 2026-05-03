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
//     it matches the wire-format and database column convention
//     (DATA-11).
//   - AbsPath is the resolved absolute path on disk (post-Canonicalize)
//     suitable for direct os.ReadFile / os.Stat.
//   - Size is the file size in bytes from fs.DirEntry.Info.
//   - MTimeUnix is the file mtime in UNIX seconds (the partial DATA-09
//     change-detection signal — Phase 2 uses mtime ONLY; checksum
//     fallback is deferred to Phase 7).
type FileMeta struct {
	CanonicalRelPath string
	AbsPath          string
	Size             int64
	MTimeUnix        int64
}

// WalkVault walks notesDir, calling yield for every .md file under it
// (DATA-01: filesystem is the source of truth). Skip rules:
//
//   - Dotdirs (`.git`, `.obsidian`, etc.) are skipped via filepath.SkipDir.
//   - The reserved `attachments/` subtree is skipped — Phase 7 owns it
//     and the indexer must not index attachment metadata as notes.
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
		// Honor cancellation between filesystem entries.
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if err != nil {
			// On the very first entry (notesDir itself), surface the
			// underlying error so callers see "directory not found" etc.
			if path == notesDir {
				return fmt.Errorf("walk %q: %w", notesDir, err)
			}
			// For nested entries, fall through — best-effort walk.
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			// Skip dotdirs (.git, .obsidian, ...) — but not the root
			// itself if notesDir happens to start with a dot.
			if path != notesDir && strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			// Phase 7 owns attachments/ — never indexed as notes.
			if path != notesDir && name == "attachments" {
				return filepath.SkipDir
			}
			return nil
		}
		// Only `.md` files. Case-insensitive on the suffix because macOS
		// APFS / WSL ext4 may both surface "Foo.MD" as written; our
		// canonical form is lowercase.
		if !strings.HasSuffix(strings.ToLower(d.Name()), ".md") {
			return nil
		}
		rel, err := filepath.Rel(notesDir, path)
		if err != nil {
			// Genuinely shouldn't happen — walk produces paths under
			// notesDir. Skip rather than abort.
			return nil
		}
		canonical, err := fsstore.Canonicalize(notesDir, rel)
		if err != nil {
			// Symlink escape, absolute-path attack, NFC failure. Skip
			// the file rather than aborting; T-02-04b-01 mitigation —
			// the indexer is a best-effort projection and the next
			// Reconcile re-tries.
			return nil
		}
		info, err := d.Info()
		if err != nil {
			// Race: file was deleted between WalkDir's directory scan
			// and our Info() call. Skip silently.
			return nil
		}
		// CanonicalRelPath is the lower-cased + NFC'd rel path used as
		// the database key. We re-canonicalize here (rel against
		// notesDir, then ToLower+NFC) by stripping notesDir from the
		// canonical absolute path the same way Canonicalize built it.
		canonRel, err := filepath.Rel(notesDir, canonical)
		if err != nil {
			return nil
		}
		// Force forward slashes in the stored path for cross-OS
		// consistency. fsstore.Canonicalize already lowercased + NFC'd.
		canonRel = filepath.ToSlash(canonRel)
		return yield(FileMeta{
			CanonicalRelPath: canonRel,
			AbsPath:          canonical,
			Size:             info.Size(),
			MTimeUnix:        info.ModTime().Unix(),
		})
	})
}
