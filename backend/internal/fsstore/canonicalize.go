// Package fsstore is the filesystem adapter for notes.FileStore. It is the
// SINGLE GATE through which every read and write of a note flows. The two
// load-bearing primitives are Canonicalize (NFC + lowercase + reject ..,
// absolute paths, symlink escapes) and AtomicWrite (temp + fsync(file) +
// rename + fsync(parent dir) — DATA-13).
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
	// ErrSymlinkLeaf is returned by ResolveContained when the final path
	// component is itself a symlink. Distinct from ErrNotInRoot because
	// callers answer it differently: a symlinked leaf is a refusal to serve
	// (403), an escape is an invalid path (400).
	ErrSymlinkLeaf = errors.New("fsstore: path leaf is a symlink")
)

// ResolveContained is the single gate for reading non-note paths out of the
// vault. Containment is decided BEFORE the leaf is stat'ed: stat-then-contain
// answers "not found" for a missing target and "invalid path" for an existing
// one, an existence oracle for arbitrary files outside the vault.
//
// A leaf-only os.Lstat cannot see a symlink on an intermediate component.
func ResolveContained(rootDir, relPath string) (string, os.FileInfo, error) {
	if relPath == "" {
		return "", nil, ErrEmptyPath
	}
	if filepath.IsAbs(relPath) {
		return "", nil, ErrAbsolutePath
	}
	cleaned := filepath.Clean(relPath)

	// The parent chain first — this is what rejects an escape without
	// revealing whether the target exists.
	if parent := filepath.Dir(cleaned); parent != "." {
		if _, err := ContainedPath(rootDir, parent); err != nil {
			return "", nil, err
		}
	}

	abs := filepath.Join(rootDir, cleaned)
	fi, err := os.Lstat(abs)
	if err != nil {
		return "", nil, err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return "", nil, ErrSymlinkLeaf
	}

	// The leaf is a real entry inside a contained parent; re-check the whole
	// path so the guarantee does not rest on the parent walk alone.
	if _, err := ContainedPath(rootDir, cleaned); err != nil {
		return "", nil, err
	}
	return abs, fi, nil
}

// Canonicalize returns the absolute path on disk for a relative note path,
// normalized to NFC + lowercase per DATA-11 so the same name resolves
// identically on macOS APFS (case-insensitive) and WSL ext4 (case-sensitive).
//
// Rejects: empty paths; absolute paths; paths containing ".." that escape
// the root after cleaning; symlinks that resolve outside the root.
//
// The returned path is suitable for direct use with os.Open / os.Stat /
// AtomicWrite.
func Canonicalize(rootDir, relPath string) (string, error) {
	if relPath == "" {
		return "", ErrEmptyPath
	}
	if filepath.IsAbs(relPath) {
		return "", ErrAbsolutePath
	}
	return ContainedPath(rootDir, strings.ToLower(norm.NFC.String(relPath)))
}

// ContainedPath is Canonicalize without the case-folding. Use it for any vault
// path that is not a note.
//
// Notes are stored case-folded so a name resolves the same on APFS and ext4;
// attachments keep the filename the user gave them. Case-folding those would
// fail to find Photo.PNG on a case-sensitive filesystem — which is why
// containment lives here and Canonicalize composes it, not the reverse.
func ContainedPath(rootDir, relPath string) (string, error) {
	if relPath == "" {
		return "", ErrEmptyPath
	}
	if filepath.IsAbs(relPath) {
		return "", ErrAbsolutePath
	}

	cleaned := filepath.Clean(relPath)
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
