package api

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
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("permission denial test requires POSIX permissions + non-root")
	}
	root := t.TempDir()
	locked := filepath.Join(root, "locked")
	if err := os.MkdirAll(locked, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() {
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

// is_vault: present + true when the listed dir contains a .jasper/ that
// isn't the app-home registry. Absent / false otherwise.
func TestGetFsList_IsVault_TrueForFolderContainingDotJasper(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".jasper"), 0o700); err != nil {
		t.Fatalf("seed .jasper: %v", err)
	}

	t.Setenv("JASPER_APP_HOME", t.TempDir())

	s := newFsListServer(t)
	resp, _ := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr(root)},
	})
	ok, isOk := resp.(GetFsList200JSONResponse)
	if !isOk {
		t.Fatalf("want 200, got %T", resp)
	}
	if ok.IsVault == nil || !*ok.IsVault {
		t.Errorf("IsVault: got %v, want pointer to true", ok.IsVault)
	}
}

func TestGetFsList_IsVault_FalseForFolderContainingAppRegistry(t *testing.T) {
	fakeHome := t.TempDir()
	appHome := filepath.Join(fakeHome, ".jasper")
	if err := os.MkdirAll(appHome, 0o700); err != nil {
		t.Fatalf("seed app home: %v", err)
	}
	t.Setenv("JASPER_APP_HOME", appHome)

	s := newFsListServer(t)
	resp, _ := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr(fakeHome)},
	})
	ok, isOk := resp.(GetFsList200JSONResponse)
	if !isOk {
		t.Fatalf("want 200, got %T", resp)
	}

	if ok.IsVault == nil || *ok.IsVault {
		t.Errorf("IsVault: got %v, want pointer to false (it's the registry)", ok.IsVault)
	}
}

func TestGetFsList_IsVault_NilWhenNoDotJasper(t *testing.T) {
	root := t.TempDir()
	t.Setenv("JASPER_APP_HOME", t.TempDir())
	s := newFsListServer(t)
	resp, _ := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr(root)},
	})
	ok, isOk := resp.(GetFsList200JSONResponse)
	if !isOk {
		t.Fatalf("want 200, got %T", resp)
	}
	if ok.IsVault != nil {
		t.Errorf("IsVault: got %v, want nil (no .jasper present)", ok.IsVault)
	}
}

func TestGetFsList_WindowsPath_OmittedOnNonWSL(t *testing.T) {
	root := t.TempDir()
	s := newFsListServer(t)
	resp, _ := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr(root)},
	})
	ok, isOk := resp.(GetFsList200JSONResponse)
	if !isOk {
		t.Fatalf("want 200, got %T", resp)
	}
	if ok.WindowsPath != nil {
		t.Errorf("WindowsPath: got %v, want nil on non-WSL", *ok.WindowsPath)
	}
}

func TestGetFsList_WindowsPath_PopulatedUnderMntWhenWSL(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	orig := isWSLProbe
	isWSLProbe = func() bool { return true }
	t.Cleanup(func() { isWSLProbe = orig })

	if _, err := os.Stat("/mnt/c"); err != nil {
		t.Skip("no /mnt/c on this host — handler wiring covered indirectly by TestWslToWindows in the platform package")
	}
	s := newFsListServer(t)
	resp, _ := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr("/mnt/c")},
	})
	ok, isOk := resp.(GetFsList200JSONResponse)
	if !isOk {
		t.Fatalf("want 200, got %T", resp)
	}
	if ok.WindowsPath == nil {
		t.Fatalf("WindowsPath: nil, want non-nil pointer to a Windows form")
	}
	if *ok.WindowsPath != `C:\` {
		t.Errorf("WindowsPath: got %q, want %q", *ok.WindowsPath, `C:\`)
	}
}

func TestGetFsList_WindowsPath_OmittedForHomeUnderWSL(t *testing.T) {
	orig := isWSLProbe
	isWSLProbe = func() bool { return true }
	t.Cleanup(func() { isWSLProbe = orig })

	root := t.TempDir()
	s := newFsListServer(t)
	resp, _ := s.GetFsList(context.Background(), GetFsListRequestObject{
		Params: GetFsListParams{Path: ptr(root)},
	})
	ok, isOk := resp.(GetFsList200JSONResponse)
	if !isOk {
		t.Fatalf("want 200, got %T", resp)
	}
	if ok.WindowsPath != nil {
		t.Errorf("WindowsPath: got %v, want nil for non-/mnt path even on WSL", *ok.WindowsPath)
	}
}

func TestGetFsList_RootHasEmptyParent(t *testing.T) {
	s := newFsListServer(t)

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

	if len(ok.Entries) == 0 && !strings.Contains(runtime.GOOS, "darwin") && runtime.GOOS != "linux" {
		t.Skip("no entries under /, skipping on non-darwin/linux env")
	}
}
