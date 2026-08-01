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
	// ErrSymlinkLeaf is returned by ResolveContained when the final path
	// component is itself a symlink. Distinct from ErrNotInRoot because
	// callers answer it differently: a symlinked leaf is a refusal to serve
	// (403), an escape is an invalid path (400).
	ErrSymlinkLeaf = errors.New("fsstore: path leaf is a symlink")
)

// ResolveContained resolves relPath under rootDir and returns the absolute
// path plus the leaf's os.Lstat FileInfo. It is the single gate for reading
// non-note paths out of the vault: files, attachments, and MCP's
// read_attachment.
//
// Containment is decided BEFORE the leaf is stat'ed. That ordering is the
// whole point and is easy to get backwards: stat-then-contain lets an escaped
// path answer "not found" when the target is missing and "invalid path" when
// it exists, which is an existence oracle for arbitrary files outside the
// vault. Rejecting on the parent chain first makes every escaped path
// indistinguishable.
//
// Symlinks on intermediate directory components are the case a leaf-only
// os.Lstat cannot see: Lstat follows ancestors, so notes/shared/secret.txt
// looks like an ordinary regular file when notes/shared is a link out of the
// vault.
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
// AtomicWrite. Pitfall 2.
func Canonicalize(rootDir, relPath string) (string, error) {
	if relPath == "" {
		return "", ErrEmptyPath
	}
	if filepath.IsAbs(relPath) {
		return "", ErrAbsolutePath
	}
	return ContainedPath(rootDir, strings.ToLower(norm.NFC.String(relPath)))
}

// ContainedPath is Canonicalize without the case-folding: it applies the same
// escape rules and the same EvalSymlinks-based containment check, but leaves
// relPath's spelling alone.
//
// Notes are stored case-folded (DATA-11) so the same name resolves identically
// on APFS and ext4; attachments and uploaded files are not — they keep the
// filename the user gave them. Running those through Canonicalize would
// case-fold the lookup and fail to find Photo.PNG on a case-sensitive
// filesystem, which is why the containment rules live here and Canonicalize
// composes them rather than the other way around.
//
// Use this for any path under the vault that is not a note. The escape
// guarantee it provides is the one thing every vault-relative path needs:
// rejecting empty, absolute and ".." paths, then resolving symlinks on BOTH
// root and target and re-checking containment — which catches a symlink on an
// intermediate directory component, invisible to an os.Lstat of the leaf.
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
