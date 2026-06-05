package api

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPostFsMkdir_HappyPath_CreatesAndReturnsCanonicalPath(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "NewFolder")

	s := newFsListServer(t)
	resp, err := s.PostFsMkdir(context.Background(), PostFsMkdirRequestObject{
		Body: &PostFsMkdirJSONRequestBody{Path: target},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ok, isOk := resp.(PostFsMkdir200JSONResponse)
	if !isOk {
		t.Fatalf("want 200, got %T", resp)
	}

	if info, statErr := os.Stat(target); statErr != nil || !info.IsDir() {
		t.Errorf("expected %s to exist as a directory after mkdir; got stat err %v", target, statErr)
	}
	if ok.Path == "" {
		t.Errorf("response Path should be non-empty canonical form; got empty")
	}
}

// vault.Canonicalize lowercases on darwin — feeding it the full path
// would create "brand new folder" on disk even though the user typed
// "Brand New Folder". Regression: handler canonicalizes the parent
// only and preserves the leaf case as typed.
func TestPostFsMkdir_PreservesCaseOfLeafName(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "Brand New Folder")
	s := newFsListServer(t)
	_, err := s.PostFsMkdir(context.Background(), PostFsMkdirRequestObject{
		Body: &PostFsMkdirJSONRequestBody{Path: target},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	entries, readErr := os.ReadDir(root)
	if readErr != nil {
		t.Fatalf("readdir: %v", readErr)
	}
	found := false
	for _, e := range entries {
		if e.Name() == "Brand New Folder" {
			found = true
			break
		}
	}
	if !found {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("expected entry named 'Brand New Folder' (case preserved); got %v", names)
	}
}

func TestPostFsMkdir_Idempotent_OnExistingDirectory(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "Existing")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatalf("seed existing dir: %v", err)
	}
	s := newFsListServer(t)
	resp, err := s.PostFsMkdir(context.Background(), PostFsMkdirRequestObject{
		Body: &PostFsMkdirJSONRequestBody{Path: target},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, isOk := resp.(PostFsMkdir200JSONResponse); !isOk {
		t.Fatalf("want 200 (idempotent), got %T", resp)
	}
}

func TestPostFsMkdir_RejectsRelativePath(t *testing.T) {
	s := newFsListServer(t)
	resp, err := s.PostFsMkdir(context.Background(), PostFsMkdirRequestObject{
		Body: &PostFsMkdirJSONRequestBody{Path: "relative/path"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	bad, isBad := resp.(PostFsMkdir400JSONResponse)
	if !isBad {
		t.Fatalf("want 400, got %T", resp)
	}
	if bad.Code != "not_absolute" {
		t.Errorf("error code: got %q, want not_absolute", bad.Code)
	}
}

func TestPostFsMkdir_ParentMissing_Returns400(t *testing.T) {
	s := newFsListServer(t)
	target := "/this/parent/definitely/does/not/exist-uat/NewFolder"
	resp, err := s.PostFsMkdir(context.Background(), PostFsMkdirRequestObject{
		Body: &PostFsMkdirJSONRequestBody{Path: target},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	bad, isBad := resp.(PostFsMkdir400JSONResponse)
	if !isBad {
		t.Fatalf("want 400 for missing parent, got %T", resp)
	}
	if bad.Code != "parent_missing" {
		t.Errorf("error code: got %q, want parent_missing", bad.Code)
	}
}

func TestPostFsMkdir_ExistsAsFile_Returns400(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "i-am-a-file.txt")
	if err := os.WriteFile(filePath, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	s := newFsListServer(t)
	resp, err := s.PostFsMkdir(context.Background(), PostFsMkdirRequestObject{
		Body: &PostFsMkdirJSONRequestBody{Path: filePath},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	bad, isBad := resp.(PostFsMkdir400JSONResponse)
	if !isBad {
		t.Fatalf("want 400 for file-collision, got %T", resp)
	}
	if bad.Code != "not_a_directory" {
		t.Errorf("error code: got %q, want not_a_directory", bad.Code)
	}
}

func TestPostFsMkdir_NonASCII_RejectedByVaultPathValidator(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "café")
	s := newFsListServer(t)
	resp, err := s.PostFsMkdir(context.Background(), PostFsMkdirRequestObject{
		Body: &PostFsMkdirJSONRequestBody{Path: target},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, isBad := resp.(PostFsMkdir400JSONResponse); !isBad {
		t.Fatalf("want 400 for non-ASCII path, got %T", resp)
	}
}

func TestPostFsMkdir_PermissionDenied_Returns403(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("requires POSIX permissions + non-root")
	}
	root := t.TempDir()
	locked := filepath.Join(root, "locked")
	if err := os.MkdirAll(locked, 0o755); err != nil {
		t.Fatalf("mkdir parent: %v", err)
	}
	if err := os.Chmod(locked, 0o500); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	target := filepath.Join(locked, "would-fail")
	s := newFsListServer(t)
	resp, err := s.PostFsMkdir(context.Background(), PostFsMkdirRequestObject{
		Body: &PostFsMkdirJSONRequestBody{Path: target},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	denied, isDenied := resp.(PostFsMkdir403JSONResponse)
	if !isDenied {
		t.Fatalf("want 403 inside locked parent, got %T", resp)
	}
	if denied.Code != "permission_denied" {
		t.Errorf("error code: got %q, want permission_denied", denied.Code)
	}
}
