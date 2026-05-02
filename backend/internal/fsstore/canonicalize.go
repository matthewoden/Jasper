// Package fsstore is the filesystem adapter for notes.FileStore. It is the
// SINGLE GATE through which every read and write of a note flows. The two
// load-bearing primitives are Canonicalize (NFC + lowercase + reject ..,
// absolute paths, symlink escapes — Pitfall 2) and AtomicWrite (temp +
// fsync(file) + rename + fsync(parent dir) — Pitfall 3 / DATA-13).
package fsstore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// Sentinel errors. All exported so callers (notes.Service, future phases) can
// gate error handling with errors.Is rather than string matching.
var (
	// ErrPathEscape is returned when a relative path resolves outside the
	// data root via "..".
	ErrPathEscape = errors.New("fsstore: path escapes data root via parent traversal")
	// ErrAbsolutePath is returned when a caller passes an absolute path.
	// Every relPath into Canonicalize MUST be relative to the data root.
	ErrAbsolutePath = errors.New("fsstore: absolute paths are not allowed")
	// ErrNotInRoot is returned when symlink resolution lands the path
	// outside the data root.
	ErrNotInRoot = errors.New("fsstore: resolved path is not under data root")
	// ErrEmptyPath is returned for an empty relative path.
	ErrEmptyPath = errors.New("fsstore: empty relative path")
)

// Canonicalize returns the absolute path on disk for a relative note path,
// normalized to NFC + lowercase per DATA-11 so the same name resolves
// identically on macOS APFS (case-insensitive) and WSL ext4 (case-sensitive).
//
// Rejects: empty paths; absolute paths; paths containing ".." that escape
// the root after cleaning; symlinks that resolve outside the root.
//
// The returned path is suitable for direct use with os.Open / os.Stat /
// AtomicWrite. Pitfall 2.
func Canonicalize(rootDir, relPath string) (string, error) {
	if relPath == "" {
		return "", ErrEmptyPath
	}
	if filepath.IsAbs(relPath) {
		return "", ErrAbsolutePath
	}

	// NFC normalize + lowercase BEFORE path cleaning so collision detection
	// works even when the input mixes Unicode forms (e.g. "café" with NFD
	// combining acute vs NFC precomposed é).
	normalized := strings.ToLower(norm.NFC.String(relPath))

	// Clean to collapse "a/b/../c" -> "a/c". Then check the result still
	// lives under root by construction (no leading ".." segment after clean).
	cleaned := filepath.Clean(normalized)
	if cleaned == ".." || cleaned == "." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		// "." is also rejected because it points at the root directory itself,
		// not a note. Empty-ish paths are not valid notes.
		if cleaned == "." {
			return "", ErrEmptyPath
		}
		return "", ErrPathEscape
	}
	if filepath.IsAbs(cleaned) {
		return "", ErrAbsolutePath
	}

	joined := filepath.Join(rootDir, cleaned)

	// Symlink-escape protection: resolve any symlinks under the joined
	// path against the root. If the resolved real path does not start
	// with the (also-resolved) root, reject. EvalSymlinks fails for paths
	// whose leaf does not exist — for a write to a brand-new file we must
	// walk back to the first existing ancestor, resolve THAT, then re-join
	// the suffix. Implemented in evalSymlinksTolerant below.
	rootResolved, err := evalSymlinksTolerant(rootDir)
	if err != nil {
		return "", fmt.Errorf("canonicalize: resolve root: %w", err)
	}
	joinedResolved, err := evalSymlinksTolerant(joined)
	if err != nil {
		return "", fmt.Errorf("canonicalize: resolve target: %w", err)
	}
	if !isUnder(joinedResolved, rootResolved) {
		return "", ErrNotInRoot
	}

	return joined, nil
}

// evalSymlinksTolerant resolves symlinks for paths that may not yet exist
// by walking up to the first ancestor that exists, calling EvalSymlinks
// on it, then re-joining the suffix that did not exist. Required because
// AtomicWrite is allowed to be called for a target file that has never
// existed before — but we still need to check that no ANCESTOR symlink
// would redirect the eventual write outside the root.
//
// On a successful EvalSymlinks call the resolved absolute path is returned.
// Any error other than "not exist" is propagated unchanged so callers see
// permission errors, IO errors, etc.
func evalSymlinksTolerant(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	// path doesn't exist — walk up to find the first ancestor that does.
	parent := filepath.Dir(path)
	// Guard against infinite recursion at the filesystem root.
	if parent == path {
		// We've reached the root and nothing exists — return the path as-is,
		// cleaned. The caller is calling against a non-existent root, which
		// will surface as a write error later.
		return filepath.Clean(path), nil
	}
	parentResolved, err := evalSymlinksTolerant(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(parentResolved, filepath.Base(path)), nil
}

// isUnder reports whether child is the same as parent or a descendant of it,
// based on the relative path between them. Both arguments must be absolute
// (post-EvalSymlinks). The "rel == \".\"" case (child equals parent) returns
// true — useful when the caller passes the root itself.
func isUnder(child, parent string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
