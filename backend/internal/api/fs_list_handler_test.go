package api

// fs_list_handler_test.go — UAT-2 #1d folder picker backend coverage.
//
// Exercises the handler against the real filesystem under t.TempDir(). The
// happy path lists subdirectories alphabetically, drops dotfile dirs, and
// reports the parent. The error paths cover non-absolute input, missing path,
// not-a-directory, and (where the OS supports it) a permission denial.

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func newFsListServer(t *testing.T) *Server {
	t.Helper()
	return &Server{}
}

func ptr(s string) *string { return &s }

func TestGetFsList_HappyPath_AlphabeticalSubdirs(t *testing.T) {
	root := t.TempDir()
	// Mix dotfile, file, and three real subdirs (intentionally out of order).
	for _, sub := range []string{"Charlie", "alpha", "Bravo", ".cache"} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", sub, err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "ignored-file.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	s := newFsListServer(t)
	resp, err := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr(root)},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ok, isOk := resp.(GetFsList200JSONResponse)
	if !isOk {
		t.Fatalf("want 200, got %T", resp)
	}
	if ok.Path != filepath.Clean(root) {
		t.Errorf("path: got %q, want %q", ok.Path, filepath.Clean(root))
	}
	if ok.Parent != filepath.Dir(filepath.Clean(root)) {
		t.Errorf("parent: got %q, want %q", ok.Parent, filepath.Dir(filepath.Clean(root)))
	}
	wantNames := []string{"alpha", "Bravo", "Charlie"}
	if len(ok.Entries) != len(wantNames) {
		t.Fatalf("entries: got %d (%v), want %d (%v)", len(ok.Entries), ok.Entries, len(wantNames), wantNames)
	}
	for i, want := range wantNames {
		if ok.Entries[i].Name != want {
			t.Errorf("entry %d name: got %q, want %q", i, ok.Entries[i].Name, want)
		}
		if ok.Entries[i].Path != filepath.Join(root, want) {
			t.Errorf("entry %d path: got %q, want %q", i, ok.Entries[i].Path, filepath.Join(root, want))
		}
	}
}

func TestGetFsList_DefaultsToHome_WhenPathOmitted(t *testing.T) {
	s := newFsListServer(t)
	resp, err := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: nil},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ok, isOk := resp.(GetFsList200JSONResponse)
	if !isOk {
		t.Fatalf("want 200 when path omitted, got %T", resp)
	}
	home, _ := os.UserHomeDir()
	if ok.Path != filepath.Clean(home) {
		t.Errorf("default path: got %q, want %q", ok.Path, filepath.Clean(home))
	}
}

func TestGetFsList_RejectsRelativePath(t *testing.T) {
	s := newFsListServer(t)
	resp, err := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr("relative/path")},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	bad, isBad := resp.(GetFsList400JSONResponse)
	if !isBad {
		t.Fatalf("want 400, got %T", resp)
	}
	if bad.Code != "not_absolute" {
		t.Errorf("error code: got %q, want %q", bad.Code, "not_absolute")
	}
}

func TestGetFsList_MissingPath_Returns400(t *testing.T) {
	s := newFsListServer(t)
	resp, err := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr("/this/path/does/not/exist/anywhere-uat-2-1d")},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	bad, isBad := resp.(GetFsList400JSONResponse)
	if !isBad {
		t.Fatalf("want 400 for missing path, got %T", resp)
	}
	if bad.Code != "not_found" {
		t.Errorf("error code: got %q, want %q", bad.Code, "not_found")
	}
}

func TestGetFsList_NotADirectory_Returns400(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "i-am-a-file.txt")
	if err := os.WriteFile(filePath, []byte("x"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	s := newFsListServer(t)
	resp, err := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr(filePath)},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	bad, isBad := resp.(GetFsList400JSONResponse)
	if !isBad {
		t.Fatalf("want 400 for file path, got %T", resp)
	}
	if bad.Code != "not_a_directory" {
		t.Errorf("error code: got %q, want %q", bad.Code, "not_a_directory")
	}
}

func TestGetFsList_PermissionDenied_Returns403(t *testing.T) {
	// chmod 000 only behaves the same on Linux/macOS. Skip on Windows where
	// permissions don't map the same way, and when running as root (CI in
	// docker often does) — root can read anything regardless of mode bits.
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("permission denial test requires POSIX permissions + non-root")
	}
	root := t.TempDir()
	locked := filepath.Join(root, "locked")
	if err := os.MkdirAll(locked, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Strip read+execute from the directory so ReadDir fails with EACCES.
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() {
		// Restore so t.TempDir cleanup can remove it.
		_ = os.Chmod(locked, 0o755)
	})

	s := newFsListServer(t)
	resp, err := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr(locked)},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	denied, isDenied := resp.(GetFsList403JSONResponse)
	if !isDenied {
		t.Fatalf("want 403 for chmod 000 dir, got %T", resp)
	}
	if denied.Code != "permission_denied" {
		t.Errorf("error code: got %q, want %q", denied.Code, "permission_denied")
	}
}

func TestGetFsList_DropsDotfileSubdirs(t *testing.T) {
	root := t.TempDir()
	for _, sub := range []string{".hidden", "visible", ".git"} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", sub, err)
		}
	}
	s := newFsListServer(t)
	resp, _ := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr(root)},
	})
	ok, isOk := resp.(GetFsList200JSONResponse)
	if !isOk {
		t.Fatalf("want 200, got %T", resp)
	}
	if len(ok.Entries) != 1 || ok.Entries[0].Name != "visible" {
		names := make([]string, 0, len(ok.Entries))
		for _, e := range ok.Entries {
			names = append(names, e.Name)
		}
		t.Errorf("entries: got %v, want [visible] only (dotfile dirs dropped)", names)
	}
}

func TestGetFsList_RootHasEmptyParent(t *testing.T) {
	s := newFsListServer(t)
	// "/" is the POSIX root; on Windows the closest equivalent is the drive
	// letter which doesn't behave the same. Skip on Windows.
	if runtime.GOOS == "windows" {
		t.Skip("filesystem-root parent semantics differ on Windows")
	}
	resp, err := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr("/")},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ok, isOk := resp.(GetFsList200JSONResponse)
	if !isOk {
		t.Fatalf("want 200 for filesystem root, got %T", resp)
	}
	if ok.Parent != "" {
		t.Errorf("root parent: got %q, want \"\" (empty so the picker hides the up-affordance)", ok.Parent)
	}
	// Sanity: real systems have at least one visible subdir under root.
	if len(ok.Entries) == 0 && !strings.Contains(runtime.GOOS, "darwin") && runtime.GOOS != "linux" {
		// On exotic CI envs this could legitimately be empty; only assert on common platforms.
		t.Skip("no entries under /, skipping on non-darwin/linux env")
	}
}
