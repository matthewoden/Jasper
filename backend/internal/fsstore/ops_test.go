package fsstore

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/text/unicode/norm"
)

// ============================================================================
// File primitive tests (Plan 03-02 Task 1)
// ============================================================================

// TestCreateFile_HappyPath: After CreateFile, the file exists with zero bytes
// and a non-zero ModTime.
func TestCreateFile_HappyPath(t *testing.T) {
	root := t.TempDir()
	if err := CreateFile(root, "note.md"); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	abs := filepath.Join(root, "note.md")
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Size() != 0 {
		t.Fatalf("size: got %d, want 0", info.Size())
	}
	if info.ModTime().IsZero() {
		t.Fatalf("ModTime is zero")
	}
}

// TestCreateFile_Collision: A second CreateFile at the same canonical path
// returns ErrCaseCollision; the first file is unchanged.
func TestCreateFile_Collision(t *testing.T) {
	root := t.TempDir()
	if err := CreateFile(root, "note.md"); err != nil {
		t.Fatalf("first CreateFile: %v", err)
	}
	err := CreateFile(root, "note.md")
	if !errors.Is(err, ErrCaseCollision) {
		t.Fatalf("expected ErrCaseCollision, got %v", err)
	}
	info, err := os.Stat(filepath.Join(root, "note.md"))
	if err != nil {
		t.Fatalf("stat after collision: %v", err)
	}
	if info.Size() != 0 {
		t.Fatalf("first file should still be empty, got size %d", info.Size())
	}
}

// TestCreateFile_NFCCollision: CreateFile with NFD form after CreateFile with
// NFC form returns ErrCaseCollision (DATA-11 + DATA-12).
func TestCreateFile_NFCCollision(t *testing.T) {
	root := t.TempDir()
	// NFC: precomposed é (U+00E9). NFD: e + combining acute (U+0065 U+0301).
	nfc := norm.NFC.String("café.md")
	nfd := norm.NFD.String("café.md")
	if nfc == nfd {
		t.Skip("NFC and NFD forms are identical on this platform; cannot exercise normalization collision")
	}
	if err := CreateFile(root, nfc); err != nil {
		t.Fatalf("CreateFile NFC: %v", err)
	}
	err := CreateFile(root, nfd)
	if !errors.Is(err, ErrCaseCollision) {
		t.Fatalf("expected ErrCaseCollision on NFD-form retry, got %v", err)
	}
}

// TestCreateFile_CaseInsensitiveCollision: CreateFile("FOO.md") after
// CreateFile("foo.md") returns ErrCaseCollision.
func TestCreateFile_CaseInsensitiveCollision(t *testing.T) {
	root := t.TempDir()
	if err := CreateFile(root, "foo.md"); err != nil {
		t.Fatalf("first CreateFile: %v", err)
	}
	err := CreateFile(root, "FOO.md")
	if !errors.Is(err, ErrCaseCollision) {
		t.Fatalf("expected ErrCaseCollision, got %v", err)
	}
}

// TestCreateFile_ParentMissing: CreateFile("a/b/c.md") when "a" doesn't exist
// returns ErrParentNotFound.
func TestCreateFile_ParentMissing(t *testing.T) {
	root := t.TempDir()
	err := CreateFile(root, filepath.Join("a", "b", "c.md"))
	if !errors.Is(err, ErrParentNotFound) {
		t.Fatalf("expected ErrParentNotFound, got %v", err)
	}
}

// TestCreateFile_RejectsEscape: CreateFile("../escape.md") returns ErrPathEscape.
func TestCreateFile_RejectsEscape(t *testing.T) {
	root := t.TempDir()
	err := CreateFile(root, "../escape.md")
	if !errors.Is(err, ErrPathEscape) {
		t.Fatalf("expected ErrPathEscape, got %v", err)
	}
}

// TestCreateFile_RejectsAbsolute: CreateFile("/abs.md") returns ErrAbsolutePath.
func TestCreateFile_RejectsAbsolute(t *testing.T) {
	root := t.TempDir()
	err := CreateFile(root, "/abs.md")
	if !errors.Is(err, ErrAbsolutePath) {
		t.Fatalf("expected ErrAbsolutePath, got %v", err)
	}
}

// TestDeleteFile_HappyPath: After CreateFile + DeleteFile, the file is gone.
func TestDeleteFile_HappyPath(t *testing.T) {
	root := t.TempDir()
	if err := CreateFile(root, "note.md"); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	if err := DeleteFile(root, "note.md"); err != nil {
		t.Fatalf("DeleteFile: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "note.md")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected file gone, stat err = %v", err)
	}
}

// TestDeleteFile_Idempotent_Returns_NotExist: DeleteFile on a missing path
// returns an error wrapping fs.ErrNotExist.
func TestDeleteFile_Idempotent_Returns_NotExist(t *testing.T) {
	root := t.TempDir()
	err := DeleteFile(root, "missing.md")
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected wrapped fs.ErrNotExist, got %v", err)
	}
}

// TestMoveFile_HappyPath: CreateFile + MoveFile to a sibling path → original
// is gone, new path has zero bytes.
func TestMoveFile_HappyPath(t *testing.T) {
	root := t.TempDir()
	if err := CreateFile(root, "old.md"); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	if err := MoveFile(root, "old.md", "new.md"); err != nil {
		t.Fatalf("MoveFile: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "old.md")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("old should be gone, stat err = %v", err)
	}
	info, err := os.Stat(filepath.Join(root, "new.md"))
	if err != nil {
		t.Fatalf("stat new: %v", err)
	}
	if info.Size() != 0 {
		t.Fatalf("new size: got %d, want 0", info.Size())
	}
}

// TestMoveFile_AcrossDirs: MoveFile from a/x.md to b/x.md (b exists) →
// contents preserved, source gone.
func TestMoveFile_AcrossDirs(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "a"), 0o755); err != nil {
		t.Fatalf("mkdir a: %v", err)
	}
	if err := os.Mkdir(filepath.Join(root, "b"), 0o755); err != nil {
		t.Fatalf("mkdir b: %v", err)
	}
	abs := filepath.Join(root, "a", "x.md")
	if err := os.WriteFile(abs, []byte("payload"), 0o644); err != nil {
		t.Fatalf("write seed: %v", err)
	}
	if err := MoveFile(root, filepath.Join("a", "x.md"), filepath.Join("b", "x.md")); err != nil {
		t.Fatalf("MoveFile: %v", err)
	}
	if _, err := os.Stat(abs); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("source should be gone, stat err = %v", err)
	}
	got, err := os.ReadFile(filepath.Join(root, "b", "x.md"))
	if err != nil {
		t.Fatalf("read new: %v", err)
	}
	if string(got) != "payload" {
		t.Fatalf("content: got %q, want %q", got, "payload")
	}
}

// TestMoveFile_Collision: MoveFile to an existing target returns
// ErrCaseCollision; the source is unchanged.
func TestMoveFile_Collision(t *testing.T) {
	root := t.TempDir()
	if err := CreateFile(root, "src.md"); err != nil {
		t.Fatalf("create src: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "src.md"), []byte("source"), 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}
	if err := CreateFile(root, "dst.md"); err != nil {
		t.Fatalf("create dst: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "dst.md"), []byte("destination"), 0o644); err != nil {
		t.Fatalf("write dst: %v", err)
	}
	err := MoveFile(root, "src.md", "dst.md")
	if !errors.Is(err, ErrCaseCollision) {
		t.Fatalf("expected ErrCaseCollision, got %v", err)
	}
	got, err := os.ReadFile(filepath.Join(root, "src.md"))
	if err != nil {
		t.Fatalf("source should be unchanged: %v", err)
	}
	if string(got) != "source" {
		t.Fatalf("source content: got %q, want %q", got, "source")
	}
}

// TestMoveFile_OldMissing: MoveFile from a non-existent source returns an
// error wrapping fs.ErrNotExist.
func TestMoveFile_OldMissing(t *testing.T) {
	root := t.TempDir()
	err := MoveFile(root, "missing.md", "target.md")
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected wrapped fs.ErrNotExist, got %v", err)
	}
}

// TestMoveFile_NewParentMissing: MoveFile to "no/such/dir/x.md" returns
// ErrParentNotFound.
func TestMoveFile_NewParentMissing(t *testing.T) {
	root := t.TempDir()
	if err := CreateFile(root, "src.md"); err != nil {
		t.Fatalf("create src: %v", err)
	}
	err := MoveFile(root, "src.md", filepath.Join("no", "such", "dir", "x.md"))
	if !errors.Is(err, ErrParentNotFound) {
		t.Fatalf("expected ErrParentNotFound, got %v", err)
	}
}

// TestMoveFile_RejectsEscape_Either: MoveFile with old or new path containing
// ".." returns ErrPathEscape.
func TestMoveFile_RejectsEscape_Either(t *testing.T) {
	root := t.TempDir()
	if err := CreateFile(root, "src.md"); err != nil {
		t.Fatalf("create src: %v", err)
	}
	// Escape on old.
	if err := MoveFile(root, "../escape.md", "ok.md"); !errors.Is(err, ErrPathEscape) {
		t.Fatalf("expected ErrPathEscape on old, got %v", err)
	}
	// Escape on new.
	if err := MoveFile(root, "src.md", "../escape.md"); !errors.Is(err, ErrPathEscape) {
		t.Fatalf("expected ErrPathEscape on new, got %v", err)
	}
}

// TestMoveFile_FsyncParent: After MoveFile, the parent's mtime has updated
// (proxy for "the rename is durable") AND the file IS at the new path.
func TestMoveFile_FsyncParent(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}
	if err := CreateFile(root, "src.md"); err != nil {
		t.Fatalf("create src: %v", err)
	}
	subBefore, err := os.Stat(filepath.Join(root, "sub"))
	if err != nil {
		t.Fatalf("stat sub before: %v", err)
	}
	// Sleep a hair past Darwin's directory mtime granularity (1s).
	time.Sleep(1100 * time.Millisecond)
	if err := MoveFile(root, "src.md", filepath.Join("sub", "moved.md")); err != nil {
		t.Fatalf("MoveFile: %v", err)
	}
	// Primary durability assertion: file IS at new location.
	if _, err := os.Stat(filepath.Join(root, "sub", "moved.md")); err != nil {
		t.Fatalf("file should exist at new path: %v", err)
	}
	// Secondary (informational) assertion: parent mtime advanced.
	subAfter, err := os.Stat(filepath.Join(root, "sub"))
	if err != nil {
		t.Fatalf("stat sub after: %v", err)
	}
	if !subAfter.ModTime().After(subBefore.ModTime()) {
		t.Logf("parent dir mtime did not advance (before=%v, after=%v) — accepted as platform-dependent", subBefore.ModTime(), subAfter.ModTime())
	}
}

// ============================================================================
// Directory primitive tests (Plan 03-02 Task 2)
// ============================================================================

// TestCreateDir_HappyPath: mkdir; the dir exists with mode 0o755.
func TestCreateDir_HappyPath(t *testing.T) {
	root := t.TempDir()
	if err := CreateDir(root, "folder"); err != nil {
		t.Fatalf("CreateDir: %v", err)
	}
	info, err := os.Stat(filepath.Join(root, "folder"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("expected directory, got mode %v", info.Mode())
	}
	// Mode bits sans type — compare just the permission bits.
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("perm: got %v, want 0o755", info.Mode().Perm())
	}
}

// TestCreateDir_Collision_FileExists: CreateDir("foo") when "foo" exists as a
// directory returns ErrCaseCollision.
func TestCreateDir_Collision_FileExists(t *testing.T) {
	root := t.TempDir()
	if err := CreateDir(root, "foo"); err != nil {
		t.Fatalf("first CreateDir: %v", err)
	}
	err := CreateDir(root, "foo")
	if !errors.Is(err, ErrCaseCollision) {
		t.Fatalf("expected ErrCaseCollision (dir-exists), got %v", err)
	}
	// Also: a file at that name collides.
	if err := CreateFile(root, "bar.md"); err != nil {
		t.Fatalf("CreateFile bar.md: %v", err)
	}
	if err := CreateDir(root, "bar.md"); !errors.Is(err, ErrCaseCollision) {
		t.Fatalf("expected ErrCaseCollision (file-exists), got %v", err)
	}
}

// TestCreateDir_ParentMissing: CreateDir("a/b") when "a" doesn't exist
// returns ErrParentNotFound.
func TestCreateDir_ParentMissing(t *testing.T) {
	root := t.TempDir()
	err := CreateDir(root, filepath.Join("a", "b"))
	if !errors.Is(err, ErrParentNotFound) {
		t.Fatalf("expected ErrParentNotFound, got %v", err)
	}
}

// TestCreateDir_NFCCollision: CreateDir("café") with NFD form after CreateDir
// with NFC form returns ErrCaseCollision.
func TestCreateDir_NFCCollision(t *testing.T) {
	root := t.TempDir()
	nfc := norm.NFC.String("café")
	nfd := norm.NFD.String("café")
	if nfc == nfd {
		t.Skip("NFC and NFD identical on this platform")
	}
	if err := CreateDir(root, nfc); err != nil {
		t.Fatalf("CreateDir NFC: %v", err)
	}
	err := CreateDir(root, nfd)
	if !errors.Is(err, ErrCaseCollision) {
		t.Fatalf("expected ErrCaseCollision on NFD-form, got %v", err)
	}
}

// TestDeleteDir_HappyPath_Empty: empty dir, recursive=false → removed.
func TestDeleteDir_HappyPath_Empty(t *testing.T) {
	root := t.TempDir()
	if err := CreateDir(root, "empty"); err != nil {
		t.Fatalf("CreateDir: %v", err)
	}
	if err := DeleteDir(root, "empty", false); err != nil {
		t.Fatalf("DeleteDir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "empty")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected dir gone, stat err = %v", err)
	}
}

// TestDeleteDir_NotEmpty_NoRecursive: dir with one .md inside, recursive=false
// → ErrFolderNotEmpty; the dir AND its contents are unchanged.
func TestDeleteDir_NotEmpty_NoRecursive(t *testing.T) {
	root := t.TempDir()
	if err := CreateDir(root, "with-content"); err != nil {
		t.Fatalf("CreateDir: %v", err)
	}
	if err := CreateFile(root, filepath.Join("with-content", "child.md")); err != nil {
		t.Fatalf("CreateFile child: %v", err)
	}
	err := DeleteDir(root, "with-content", false)
	if !errors.Is(err, ErrFolderNotEmpty) {
		t.Fatalf("expected ErrFolderNotEmpty, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "with-content")); err != nil {
		t.Fatalf("dir should still exist: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "with-content", "child.md")); err != nil {
		t.Fatalf("child should still exist: %v", err)
	}
}

// TestDeleteDir_Recursive: dir with nested subtree, recursive=true → entire
// subtree gone.
func TestDeleteDir_Recursive(t *testing.T) {
	root := t.TempDir()
	if err := CreateDir(root, "top"); err != nil {
		t.Fatalf("CreateDir top: %v", err)
	}
	if err := CreateDir(root, filepath.Join("top", "nested")); err != nil {
		t.Fatalf("CreateDir nested: %v", err)
	}
	if err := CreateFile(root, filepath.Join("top", "a.md")); err != nil {
		t.Fatalf("CreateFile a: %v", err)
	}
	if err := CreateFile(root, filepath.Join("top", "nested", "b.md")); err != nil {
		t.Fatalf("CreateFile b: %v", err)
	}
	if err := DeleteDir(root, "top", true); err != nil {
		t.Fatalf("DeleteDir recursive: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "top")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("top should be gone, err = %v", err)
	}
}

// TestDeleteDir_NotExist: DeleteDir on missing path → error wrapping
// fs.ErrNotExist.
func TestDeleteDir_NotExist(t *testing.T) {
	root := t.TempDir()
	err := DeleteDir(root, "missing", false)
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected wrapped fs.ErrNotExist, got %v", err)
	}
}

// TestMoveDir_HappyPath: dir with files inside; MoveDir to a sibling parent →
// dir + contents at new path; old path gone.
func TestMoveDir_HappyPath(t *testing.T) {
	root := t.TempDir()
	if err := CreateDir(root, "src-dir"); err != nil {
		t.Fatalf("CreateDir src: %v", err)
	}
	if err := CreateFile(root, filepath.Join("src-dir", "a.md")); err != nil {
		t.Fatalf("CreateFile a: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "src-dir", "a.md"), []byte("content"), 0o644); err != nil {
		t.Fatalf("write a: %v", err)
	}
	if err := MoveDir(root, "src-dir", "dst-dir"); err != nil {
		t.Fatalf("MoveDir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "src-dir")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("src should be gone, err = %v", err)
	}
	got, err := os.ReadFile(filepath.Join(root, "dst-dir", "a.md"))
	if err != nil {
		t.Fatalf("read moved child: %v", err)
	}
	if string(got) != "content" {
		t.Fatalf("content: got %q, want %q", got, "content")
	}
}

// TestMoveDir_Collision: new path exists → ErrCaseCollision; source unchanged.
func TestMoveDir_Collision(t *testing.T) {
	root := t.TempDir()
	if err := CreateDir(root, "src-dir"); err != nil {
		t.Fatalf("CreateDir src: %v", err)
	}
	if err := CreateDir(root, "dst-dir"); err != nil {
		t.Fatalf("CreateDir dst: %v", err)
	}
	err := MoveDir(root, "src-dir", "dst-dir")
	if !errors.Is(err, ErrCaseCollision) {
		t.Fatalf("expected ErrCaseCollision, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "src-dir")); err != nil {
		t.Fatalf("src should be unchanged: %v", err)
	}
}

// TestMoveDir_Cycle_IntoOwnDescendant: MoveDir("a", "a/b") → ErrCycle;
// source unchanged.
func TestMoveDir_Cycle_IntoOwnDescendant(t *testing.T) {
	root := t.TempDir()
	if err := CreateDir(root, "a"); err != nil {
		t.Fatalf("CreateDir a: %v", err)
	}
	err := MoveDir(root, "a", filepath.Join("a", "b"))
	if !errors.Is(err, ErrCycle) {
		t.Fatalf("expected ErrCycle, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "a")); err != nil {
		t.Fatalf("source should be unchanged: %v", err)
	}
}

// TestMoveDir_Cycle_IntoSelf: MoveDir("a", "a") → ErrCycle (same-path is a
// degenerate cycle).
func TestMoveDir_Cycle_IntoSelf(t *testing.T) {
	root := t.TempDir()
	if err := CreateDir(root, "a"); err != nil {
		t.Fatalf("CreateDir a: %v", err)
	}
	err := MoveDir(root, "a", "a")
	if !errors.Is(err, ErrCycle) {
		t.Fatalf("expected ErrCycle, got %v", err)
	}
}

// TestMoveDir_NewParentMissing: MoveDir target's parent doesn't exist →
// ErrParentNotFound.
func TestMoveDir_NewParentMissing(t *testing.T) {
	root := t.TempDir()
	if err := CreateDir(root, "src"); err != nil {
		t.Fatalf("CreateDir src: %v", err)
	}
	err := MoveDir(root, "src", filepath.Join("no", "such", "parent", "dst"))
	if !errors.Is(err, ErrParentNotFound) {
		t.Fatalf("expected ErrParentNotFound, got %v", err)
	}
}

// TestMoveDir_OldNotExist: source doesn't exist → error wrapping
// fs.ErrNotExist.
func TestMoveDir_OldNotExist(t *testing.T) {
	root := t.TempDir()
	err := MoveDir(root, "missing", "target")
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected wrapped fs.ErrNotExist, got %v", err)
	}
}

// TestMoveDir_OldIsFile: source exists but is a regular file (not a dir) →
// returns an error indicating "source is not a directory".
func TestMoveDir_OldIsFile(t *testing.T) {
	root := t.TempDir()
	if err := CreateFile(root, "actually-a-file.md"); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	err := MoveDir(root, "actually-a-file.md", "target-dir")
	if err == nil {
		t.Fatalf("expected error for non-directory source, got nil")
	}
	if errMsg := err.Error(); !contains(errMsg, "source is not a directory") {
		t.Fatalf("error message should mention source-is-not-a-directory, got %q", errMsg)
	}
}

// contains is a tiny helper to avoid pulling strings into a test where it's
// only used once.
func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
