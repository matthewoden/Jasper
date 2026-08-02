package fsstore

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// maxTrashSuffix is the upper bound on the collision-suffix loop to prevent
// unbounded iteration — single-user, local-only; pathological counts are
// not a realistic threat.
const maxTrashSuffix = 10_000

// Sentinel errors for the CRUD primitives. Callers gate via errors.Is.
var (
	// ErrCaseCollision is returned when a create/move target already exists
	// at its canonicalized path. Maps to HTTP 409 in the API layer.
	ErrCaseCollision = errors.New("fsstore: target path already exists")
	// ErrFolderNotEmpty is returned when DeleteDir(recursive=false) sees children.
	ErrFolderNotEmpty = errors.New("fsstore: folder is not empty")
	// ErrParentNotFound is returned when a create/move target's parent does
	// not exist. Callers typically map to 400.
	ErrParentNotFound = errors.New("fsstore: parent path does not exist")
	// ErrCycle is returned when MoveDir would land the source inside its own
	// subtree (move-into-self or move-into-descendant).
	ErrCycle = errors.New("fsstore: cannot move a folder into its own descendant")
)

// CreateFile creates an empty .md file at relPath, propagating every
// Canonicalize sentinel unchanged.
//
// Only the IMMEDIATE parent may be missing-checked: a multi-level chain returns
// ErrParentNotFound rather than being created implicitly.
func CreateFile(rootDir, relPath string) error {
	abs, err := Canonicalize(rootDir, relPath)
	if err != nil {
		return fmt.Errorf("fsstore.CreateFile(%q): %w", relPath, err)
	}
	if _, statErr := os.Stat(abs); statErr == nil {
		return fmt.Errorf("fsstore.CreateFile(%q): %w", relPath, ErrCaseCollision)
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return fmt.Errorf("fsstore.CreateFile(%q): stat: %w", relPath, statErr)
	}
	parent := filepath.Dir(abs)
	if _, err := os.Stat(parent); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("fsstore.CreateFile(%q): %w", relPath, ErrParentNotFound)
		}
		return fmt.Errorf("fsstore.CreateFile(%q): stat parent: %w", relPath, err)
	}
	if err := AtomicWrite(abs, []byte{}); err != nil {
		return fmt.Errorf("fsstore.CreateFile(%q): %w", relPath, err)
	}
	return nil
}

// DeleteFile removes the file at relPath. fs.ErrNotExist is propagated so the
// caller decides idempotency.
func DeleteFile(rootDir, relPath string) error {
	abs, err := Canonicalize(rootDir, relPath)
	if err != nil {
		return fmt.Errorf("fsstore.DeleteFile(%q): %w", relPath, err)
	}
	if err := os.Remove(abs); err != nil {
		return fmt.Errorf("fsstore.DeleteFile(%q): %w", relPath, err)
	}
	return nil
}

// MoveFile renames a file. Both paths are canonicalized; ErrCaseCollision if
// the new target exists; the parent of the new path must exist (single-level
// only — chains require explicit CreateDir).
//
// The rename is followed by an fsync of the new parent directory to make the
// directory-entry change durable across power loss.
func MoveFile(rootDir, oldRelPath, newRelPath string) error {
	oldAbs, err := Canonicalize(rootDir, oldRelPath)
	if err != nil {
		return fmt.Errorf("fsstore.MoveFile(old=%q): %w", oldRelPath, err)
	}
	newAbs, err := Canonicalize(rootDir, newRelPath)
	if err != nil {
		return fmt.Errorf("fsstore.MoveFile(new=%q): %w", newRelPath, err)
	}
	if _, statErr := os.Stat(newAbs); statErr == nil {
		return fmt.Errorf("fsstore.MoveFile(%q→%q): %w", oldRelPath, newRelPath, ErrCaseCollision)
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return fmt.Errorf("fsstore.MoveFile(%q→%q): stat new: %w", oldRelPath, newRelPath, statErr)
	}
	newParent := filepath.Dir(newAbs)
	if _, err := os.Stat(newParent); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("fsstore.MoveFile(%q→%q): %w", oldRelPath, newRelPath, ErrParentNotFound)
		}
		return fmt.Errorf("fsstore.MoveFile(%q→%q): stat new parent: %w", oldRelPath, newRelPath, err)
	}
	if err := os.Rename(oldAbs, newAbs); err != nil {
		return fmt.Errorf("fsstore.MoveFile(%q→%q): rename: %w", oldRelPath, newRelPath, err)
	}
	dirf, err := os.Open(newParent)
	if err != nil {
		return fmt.Errorf("fsstore.MoveFile(%q→%q): open parent for fsync: %w", oldRelPath, newRelPath, err)
	}
	if err := dirf.Sync(); err != nil {
		_ = dirf.Close()
		return fmt.Errorf("fsstore.MoveFile(%q→%q): fsync parent: %w", oldRelPath, newRelPath, err)
	}
	if err := dirf.Close(); err != nil {
		return fmt.Errorf("fsstore.MoveFile(%q→%q): close parent: %w", oldRelPath, newRelPath, err)
	}
	return nil
}

// CreateDir creates a directory at relPath under rootDir with mode 0o755.
// Rejects collisions (any pre-existing inode at that path — file or
// directory) and ErrParentNotFound when the immediate parent doesn't exist.
// The parent directory is fsynced after mkdir for power-loss durability.
func CreateDir(rootDir, relPath string) error {
	abs, err := Canonicalize(rootDir, relPath)
	if err != nil {
		return fmt.Errorf("fsstore.CreateDir(%q): %w", relPath, err)
	}
	if _, statErr := os.Stat(abs); statErr == nil {
		return fmt.Errorf("fsstore.CreateDir(%q): %w", relPath, ErrCaseCollision)
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return fmt.Errorf("fsstore.CreateDir(%q): stat: %w", relPath, statErr)
	}
	parent := filepath.Dir(abs)
	if _, err := os.Stat(parent); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("fsstore.CreateDir(%q): %w", relPath, ErrParentNotFound)
		}
		return fmt.Errorf("fsstore.CreateDir(%q): stat parent: %w", relPath, err)
	}
	if err := os.Mkdir(abs, 0o755); err != nil {
		return fmt.Errorf("fsstore.CreateDir(%q): mkdir: %w", relPath, err)
	}

	dirf, err := os.Open(parent)
	if err != nil {
		return fmt.Errorf("fsstore.CreateDir(%q): open parent for fsync: %w", relPath, err)
	}
	if err := dirf.Sync(); err != nil {
		_ = dirf.Close()
		return fmt.Errorf("fsstore.CreateDir(%q): fsync parent: %w", relPath, err)
	}
	if err := dirf.Close(); err != nil {
		return fmt.Errorf("fsstore.CreateDir(%q): close parent: %w", relPath, err)
	}
	return nil
}

// DeleteDir removes a directory. With recursive=false, returns
// ErrFolderNotEmpty if the directory has any children. With recursive=true,
// deletes the entire subtree via os.RemoveAll.
//
// The Canonicalize gate ensures the resolved absolute path is under root;
// since EvalSymlinks resolution is part of Canonicalize, RemoveAll cannot
// be redirected outside the data root via a symlinked ancestor.
func DeleteDir(rootDir, relPath string, recursive bool) error {
	abs, err := Canonicalize(rootDir, relPath)
	if err != nil {
		return fmt.Errorf("fsstore.DeleteDir(%q): %w", relPath, err)
	}
	if !recursive {
		df, err := os.Open(abs)
		if err != nil {
			return fmt.Errorf("fsstore.DeleteDir(%q): %w", relPath, err)
		}
		names, readErr := df.Readdirnames(1)
		closeErr := df.Close()
		if readErr != nil && !errors.Is(readErr, fs.ErrNotExist) && readErr.Error() != "EOF" {
			return fmt.Errorf("fsstore.DeleteDir(%q): readdir: %w", relPath, readErr)
		}
		if closeErr != nil {
			return fmt.Errorf("fsstore.DeleteDir(%q): close: %w", relPath, closeErr)
		}
		if len(names) > 0 {
			return fmt.Errorf("fsstore.DeleteDir(%q): %w", relPath, ErrFolderNotEmpty)
		}
		if err := os.Remove(abs); err != nil {
			return fmt.Errorf("fsstore.DeleteDir(%q): remove: %w", relPath, err)
		}
		return nil
	}

	info, err := os.Lstat(abs)
	if err != nil {
		return fmt.Errorf("fsstore.DeleteDir(%q): %w", relPath, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("fsstore.DeleteDir(%q): target is not a directory", relPath)
	}
	if err := os.RemoveAll(abs); err != nil {
		return fmt.Errorf("fsstore.DeleteDir(%q): removeall: %w", relPath, err)
	}
	return nil
}

// MoveDir renames a directory. Both paths are canonicalized; the target must
// not exist (ErrCaseCollision); the new path's immediate parent must exist
// (ErrParentNotFound); and the new path must NOT be the source itself or any
// descendant of the source (ErrCycle). The source must exist as a directory
// (errors otherwise).
func MoveDir(rootDir, oldRelPath, newRelPath string) error {
	oldAbs, err := Canonicalize(rootDir, oldRelPath)
	if err != nil {
		return fmt.Errorf("fsstore.MoveDir(old=%q): %w", oldRelPath, err)
	}
	newAbs, err := Canonicalize(rootDir, newRelPath)
	if err != nil {
		return fmt.Errorf("fsstore.MoveDir(new=%q): %w", newRelPath, err)
	}

	if isPathInside(newAbs, oldAbs) {
		return fmt.Errorf("fsstore.MoveDir(%q→%q): %w", oldRelPath, newRelPath, ErrCycle)
	}

	oldInfo, err := os.Lstat(oldAbs)
	if err != nil {
		return fmt.Errorf("fsstore.MoveDir(%q→%q): stat old: %w", oldRelPath, newRelPath, err)
	}
	if !oldInfo.IsDir() {
		return fmt.Errorf("fsstore.MoveDir(%q→%q): source is not a directory", oldRelPath, newRelPath)
	}

	if _, statErr := os.Stat(newAbs); statErr == nil {
		return fmt.Errorf("fsstore.MoveDir(%q→%q): %w", oldRelPath, newRelPath, ErrCaseCollision)
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return fmt.Errorf("fsstore.MoveDir(%q→%q): stat new: %w", oldRelPath, newRelPath, statErr)
	}

	newParent := filepath.Dir(newAbs)
	if _, err := os.Stat(newParent); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("fsstore.MoveDir(%q→%q): %w", oldRelPath, newRelPath, ErrParentNotFound)
		}
		return fmt.Errorf("fsstore.MoveDir(%q→%q): stat new parent: %w", oldRelPath, newRelPath, err)
	}

	if err := os.Rename(oldAbs, newAbs); err != nil {
		return fmt.Errorf("fsstore.MoveDir(%q→%q): rename: %w", oldRelPath, newRelPath, err)
	}

	dirf, err := os.Open(newParent)
	if err != nil {
		return fmt.Errorf("fsstore.MoveDir(%q→%q): open parent for fsync: %w", oldRelPath, newRelPath, err)
	}
	if err := dirf.Sync(); err != nil {
		_ = dirf.Close()
		return fmt.Errorf("fsstore.MoveDir(%q→%q): fsync parent: %w", oldRelPath, newRelPath, err)
	}
	if err := dirf.Close(); err != nil {
		return fmt.Errorf("fsstore.MoveDir(%q→%q): close parent: %w", oldRelPath, newRelPath, err)
	}
	return nil
}

func isPathInside(child, parent string) bool {
	if child == parent {
		return true
	}
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// TrashFile moves a single note file from notes/<relPath> into <dataDir>/.trash/,
// flattening the source folder path. If a same-named file already exists
// in .trash/ it appends a numeric suffix in Obsidian format (foo 1.md, foo 2.md)
// — never overwrites (TRASH-04). Returns the trashName (basename only, e.g. "foo.md").
//
// All paths are routed through Canonicalize(dataDir, ...) so path-escape and
// symlink attacks are rejected. relPath must be a non-empty relative
// path (no leading slash, no ".." that escapes notes/).
func TrashFile(dataDir, relPath string) (string, error) {
	if err := validateTrashRelPath(relPath); err != nil {
		return "", fmt.Errorf("fsstore.TrashFile(%q): %w", relPath, err)
	}

	stem := strings.TrimSuffix(filepath.Base(filepath.ToSlash(relPath)), ".md")
	ext := ".md"

	name, err := destTrashName(dataDir, stem, ext)
	if err != nil {
		return "", fmt.Errorf("fsstore.TrashFile(%q): name: %w", relPath, err)
	}

	srcRel := filepath.ToSlash(filepath.Join("notes", relPath))
	dstRel := filepath.ToSlash(filepath.Join(".trash", name))

	if err := moveWithinDataDir(dataDir, srcRel, dstRel); err != nil {
		return "", fmt.Errorf("fsstore.TrashFile(%q): %w", relPath, err)
	}
	return name, nil
}

// TrashDir moves a folder from notes/<relPath> into <dataDir>/.trash/ with the
// full subtree intact. If a same-named folder already exists in .trash/
// it appends a numeric suffix (projects 1, projects 2). Returns the trashName
// (e.g. "projects" or "projects 1").
func TrashDir(dataDir, relPath string) (string, error) {
	if err := validateTrashRelPath(relPath); err != nil {
		return "", fmt.Errorf("fsstore.TrashDir(%q): %w", relPath, err)
	}

	stem := filepath.Base(filepath.ToSlash(relPath))
	ext := ""

	name, err := destTrashName(dataDir, stem, ext)
	if err != nil {
		return "", fmt.Errorf("fsstore.TrashDir(%q): name: %w", relPath, err)
	}

	srcRel := filepath.ToSlash(filepath.Join("notes", relPath))
	dstRel := filepath.ToSlash(filepath.Join(".trash", name))

	if err := moveWithinDataDir(dataDir, srcRel, dstRel); err != nil {
		return "", fmt.Errorf("fsstore.TrashDir(%q): %w", relPath, err)
	}
	return name, nil
}

// validateTrashRelPath performs early path validation before constructing the
// notes/-prefixed source relpath. filepath.Join silently absorbs absolute paths
// and ".." components, so we must check the raw relPath before joining.
func validateTrashRelPath(relPath string) error {
	if relPath == "" {
		return ErrEmptyPath
	}
	if filepath.IsAbs(relPath) {
		return ErrAbsolutePath
	}
	// Check for ".." escape. filepath.Clean then check for leading "..".
	cleaned := filepath.Clean(relPath)
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return ErrPathEscape
	}
	return nil
}

// moveWithinDataDir is structurally identical to MoveFile but rooted at
// dataDir instead of notesDir, allowing both source (under notes/) and
// destination (under .trash/) to be expressed as relpaths under the same root.
// The pre-rename os.Stat guard (no-overwrite) and fsync-parent are preserved
// from MoveFile (TRASH-04 + data durability).
func moveWithinDataDir(dataDir, srcRel, dstRel string) error {
	srcAbs, err := Canonicalize(dataDir, srcRel)
	if err != nil {
		return fmt.Errorf("moveWithinDataDir(src=%q): %w", srcRel, err)
	}
	dstAbs, err := Canonicalize(dataDir, dstRel)
	if err != nil {
		return fmt.Errorf("moveWithinDataDir(dst=%q): %w", dstRel, err)
	}

	// Authoritative no-overwrite guard: os.Rename on POSIX overwrites
	// file targets silently; the pre-stat prevents silent data loss.
	if _, statErr := os.Stat(dstAbs); statErr == nil {
		return fmt.Errorf("moveWithinDataDir(%q→%q): %w", srcRel, dstRel, ErrCaseCollision)
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return fmt.Errorf("moveWithinDataDir(%q→%q): stat dst: %w", srcRel, dstRel, statErr)
	}

	dstParent := filepath.Dir(dstAbs)
	if _, err := os.Stat(dstParent); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("moveWithinDataDir(%q→%q): %w", srcRel, dstRel, ErrParentNotFound)
		}
		return fmt.Errorf("moveWithinDataDir(%q→%q): stat dst parent: %w", srcRel, dstRel, err)
	}

	if err := os.Rename(srcAbs, dstAbs); err != nil {
		return fmt.Errorf("moveWithinDataDir(%q→%q): rename: %w", srcRel, dstRel, err)
	}

	dirf, err := os.Open(dstParent)
	if err != nil {
		return fmt.Errorf("moveWithinDataDir(%q→%q): open parent for fsync: %w", srcRel, dstRel, err)
	}
	if err := dirf.Sync(); err != nil {
		_ = dirf.Close()
		return fmt.Errorf("moveWithinDataDir(%q→%q): fsync parent: %w", srcRel, dstRel, err)
	}
	if err := dirf.Close(); err != nil {
		return fmt.Errorf("moveWithinDataDir(%q→%q): close parent: %w", srcRel, dstRel, err)
	}
	return nil
}

// destTrashName returns the first free filename candidate in <dataDir>/.trash/
// for an item with the given stem and ext. The first candidate is stem+ext; if
// it exists the loop produces "stem 1"+ext, "stem 2"+ext, … up to maxTrashSuffix.
//
// Existence is checked by resolving Canonicalize(dataDir, ".trash/<candidate>")
// then os.Stat, so the comparison is NFC+lowercase-aware.
func destTrashName(dataDir, stem, ext string) (string, error) {
	for i := 0; i <= maxTrashSuffix; i++ {
		var candidate string
		if i == 0 {
			candidate = stem + ext
		} else {
			candidate = fmt.Sprintf("%s %d%s", stem, i, ext)
		}
		rel := filepath.ToSlash(filepath.Join(".trash", candidate))
		abs, err := Canonicalize(dataDir, rel)
		if err != nil {
			return "", fmt.Errorf("destTrashName: canonicalize %q: %w", rel, err)
		}
		if _, err := os.Stat(abs); errors.Is(err, fs.ErrNotExist) {
			return candidate, nil
		} else if err != nil {
			return "", fmt.Errorf("destTrashName: stat %q: %w", abs, err)
		}
		// candidate exists — try next suffix
	}
	return "", fmt.Errorf("destTrashName: exceeded %d collision suffixes for %q", maxTrashSuffix, stem+ext)
}
