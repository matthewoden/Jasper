package api

// files_test.go — tests for GET /api/v1/files?path=... (Plan 07-32a / UAT-3 R7).
//
// Mirrors attachments_handler_test.go's TestAttachmentsSecurity layout: each test
// constructs an isolated *Server via newAttachmentTestServer (re-used here because
// the helper sets up a temp dataDir with notes/ pre-created and a fake index),
// then invokes srv.GetFile directly with a synthesized GetFileRequestObject.
//
// Path-traversal pipeline mirrors GetAttachment (5 rules) — the only addition is
// .md refusal (Rule 2b), which forces non-markdown files through this endpoint
// and keeps note bodies on /notes/{id} where the lookup-by-UUID model lives.

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// callGetFile invokes the GetFile handler with the given relative path as the
// query-parameter value. Returns the typed response object.
func callGetFile(t *testing.T, srv *Server, relPath string) GetFileResponseObject {
	t.Helper()
	resp, err := srv.GetFile(context.Background(), GetFileRequestObject{
		Params: GetFileParams{Path: relPath},
	})
	if err != nil {
		t.Fatalf("GetFile error: %v", err)
	}
	return resp
}

// TestGetFile_HappyPath: a real file under notes/sub/ returns 200 with its bytes.
//
// Exercises the multi-segment path case (sub/photo.png) which is the entire
// reason the investigation chose the query-param approach over a chi catch-all.
func TestGetFile_HappyPath(t *testing.T) {
	t.Parallel()

	srv, dataDir := newAttachmentTestServer(t, nil)

	// Create notes/sub/photo.png.
	subDir := filepath.Join(dataDir, "notes", "sub")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}
	want := []byte("\x89PNG\r\n\x1a\nfake-image-bytes")
	if err := os.WriteFile(filepath.Join(subDir, "photo.png"), want, 0o644); err != nil {
		t.Fatalf("write photo.png: %v", err)
	}

	resp := callGetFile(t, srv, "sub/photo.png")
	got200, ok := resp.(GetFile200ApplicationoctetStreamResponse)
	if !ok {
		t.Fatalf("expected GetFile200ApplicationoctetStreamResponse, got %T", resp)
	}
	body, err := io.ReadAll(got200.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != string(want) {
		t.Errorf("body: got %q, want %q", body, want)
	}
	if got200.ContentLength != int64(len(want)) {
		t.Errorf("ContentLength: got %d, want %d", got200.ContentLength, len(want))
	}
}

// TestGetFile_PathTraversal: any path containing ".." is rejected with 400.
func TestGetFile_PathTraversal(t *testing.T) {
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)

	bad := []string{
		"../../../etc/passwd",
		"..",
		"sub/../../../etc/passwd",
		"sub/..",
	}
	for _, p := range bad {
		resp := callGetFile(t, srv, p)
		got400, ok := resp.(GetFile400JSONResponse)
		if !ok {
			t.Errorf("path=%q: expected GetFile400JSONResponse, got %T", p, resp)
			continue
		}
		if got400.Code != "invalid_path" {
			t.Errorf("path=%q: code: got %q, want %q", p, got400.Code, "invalid_path")
		}
	}
}

// TestGetFile_AbsolutePath: any absolute path (leading "/") is rejected with 400.
//
// HTTP-level "GET /api/v1/files?path=/etc/passwd" delivers path="/etc/passwd"
// to req.Params.Path; the handler must reject the leading slash before the
// filepath.Join would silently re-anchor (filepath.Join strips leading slashes
// on the second arg, but Rule 1 makes the rejection explicit).
func TestGetFile_AbsolutePath(t *testing.T) {
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)

	resp := callGetFile(t, srv, "/etc/passwd")
	got400, ok := resp.(GetFile400JSONResponse)
	if !ok {
		t.Fatalf("expected GetFile400JSONResponse, got %T", resp)
	}
	if got400.Code != "invalid_path" {
		t.Errorf("code: got %q, want %q", got400.Code, "invalid_path")
	}
}

// TestGetFile_Symlink: a symlink under notes/ pointing outside the vault
// returns 403 (os.Lstat + Mode()&os.ModeSymlink check, Rule 5).
func TestGetFile_Symlink(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	// File outside the vault holding the secret.
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret data"), 0o600); err != nil {
		t.Fatalf("write outside: %v", err)
	}

	// Symlink it INTO notes/ as evil.bin.
	notesDir := filepath.Join(dataDir, "notes")
	symlinkPath := filepath.Join(notesDir, "evil.bin")
	if err := os.Symlink(outside, symlinkPath); err != nil {
		t.Skipf("symlinks not supported: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(symlinkPath) })

	resp := callGetFile(t, srv, "evil.bin")
	got403, ok := resp.(GetFile403JSONResponse)
	if !ok {
		t.Fatalf("expected GetFile403JSONResponse, got %T", resp)
	}
	if got403.Code != "symlink_rejected" {
		t.Errorf("code: got %q, want %q", got403.Code, "symlink_rejected")
	}
}

// TestGetFile_NotFound: an absent file returns 404.
func TestGetFile_NotFound(t *testing.T) {
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)

	resp := callGetFile(t, srv, "nope.png")
	got404, ok := resp.(GetFile404JSONResponse)
	if !ok {
		t.Fatalf("expected GetFile404JSONResponse, got %T", resp)
	}
	if got404.Code != "not_found" {
		t.Errorf("code: got %q, want %q", got404.Code, "not_found")
	}
}

// TestGetFile_RootMd_Rejected: .md files (any case) are refused with 404 to
// keep markdown bodies on the /notes/{id} surface (which has the lookup-by-UUID
// + ETag model). Per the plan's TestGetFile_RootMd_Rejected requirement.
func TestGetFile_RootMd_Rejected(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	// Create a real .md file so the test would succeed if the .md guard were missing.
	if err := os.WriteFile(filepath.Join(dataDir, "notes", "leak.md"), []byte("secret note"), 0o644); err != nil {
		t.Fatalf("write md: %v", err)
	}

	for _, p := range []string{"leak.md", "leak.MD", "sub/leak.md"} {
		resp := callGetFile(t, srv, p)
		got404, ok := resp.(GetFile404JSONResponse)
		if !ok {
			t.Errorf("path=%q: expected GetFile404JSONResponse, got %T", p, resp)
			continue
		}
		if got404.Code != "not_found" {
			t.Errorf("path=%q: code: got %q, want %q", p, got404.Code, "not_found")
		}
	}
}
