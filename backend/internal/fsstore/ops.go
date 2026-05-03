// Package-level documentation lives in canonicalize.go. This file owns the
// higher-level CRUD primitives (Create/Delete/Move for files and directories).
// Each primitive routes through Canonicalize FIRST so the data-root invariant
// from Phase 1 (Pitfall 2) holds for every entry point.
package fsstore

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Sentinel errors for the CRUD primitives. Callers gate via errors.Is.
var (
	// ErrCaseCollision is returned when a create/move target already exists
	// at its canonicalized path. Maps to HTTP 409 in the API layer (DATA-12).
	ErrCaseCollision = errors.New("fsstore: target path already exists")
	// ErrFolderNotEmpty is returned when DeleteDir(recursive=false) sees children.
	ErrFolderNotEmpty = errors.New("fsstore: folder is not empty")
	// ErrParentNotFound is returned when a create/move target's parent does
	// not exist. Callers (the API layer in Plan 03-04) typically map to 400.
	ErrParentNotFound = errors.New("fsstore: parent path does not exist")
	// ErrCycle is returned when MoveDir would land the source inside its own
	// subtree (move-into-self or move-into-descendant).
	ErrCycle = errors.New("fsstore: cannot move a folder into its own descendant")
)

// CreateFile creates an empty .md file at relPath under rootDir using
// AtomicWrite for durability. Rejects collisions (DATA-12) and propagates
// every Canonicalize sentinel (ErrPathEscape / ErrAbsolutePath / ErrEmptyPath
// / ErrNotInRoot) unchanged.
//
// Behavior choices:
//   - The IMMEDIATE parent directory must exist (single-level only). Multi-
//     level missing chains return ErrParentNotFound — callers must create
//     the chain explicitly via CreateDir or the API layer must reject the
//     request as 400.
//   - The file is created with zero bytes; the API handler in Plan 03-04
//     immediately calls Service.Update to seed any initial content (or
//     leaves empty per UI-SPEC: "creates a temp file ... immediately enters
//     inline-rename mode").
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
// caller decides idempotency — the API layer in Plan 03-04 maps to 404
// because the user-visible "delete a note" semantic IS not-found if the row
// is gone.
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
// directory-entry change durable across power loss — same pattern AtomicWrite
// uses (atomic.go step 5).
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

// CreateDir / DeleteDir / MoveDir — Task 2 lands the bodies. Stubs declared
// here so the package surface compiles for early callers. The sentinel errors
// (ErrFolderNotEmpty, ErrCycle) are already declared above.
func CreateDir(rootDir, relPath string) error {
	return errors.New("ops: CreateDir lands in Plan 03-02 Task 2")
}

func DeleteDir(rootDir, relPath string, recursive bool) error {
	return errors.New("ops: DeleteDir lands in Plan 03-02 Task 2")
}

func MoveDir(rootDir, oldRelPath, newRelPath string) error {
	return errors.New("ops: MoveDir lands in Plan 03-02 Task 2")
}
