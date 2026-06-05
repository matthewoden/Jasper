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

	normalized := strings.ToLower(norm.NFC.String(relPath))

	cleaned := filepath.Clean(normalized)
	if cleaned == ".." || cleaned == "." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		if cleaned == "." {
			return "", ErrEmptyPath
		}
		return "", ErrPathEscape
	}
	if filepath.IsAbs(cleaned) {
		return "", ErrAbsolutePath
	}

	joined := filepath.Join(rootDir, cleaned)

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

func evalSymlinksTolerant(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}

	parent := filepath.Dir(path)

	if parent == path {
		return filepath.Clean(path), nil
	}
	parentResolved, err := evalSymlinksTolerant(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(parentResolved, filepath.Base(path)), nil
}

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
