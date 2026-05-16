package api

// files_test.go — tests for GET + POST /api/v1/files?path=... (Plans 07-32a + 07-34).
//
// Mirrors attachments_handler_test.go's TestAttachmentsSecurity layout: each test
// constructs an isolated *Server via newAttachmentTestServer (re-used here because
// the helper sets up a temp dataDir with notes/ pre-created and a fake index),
// then invokes srv.GetFile / srv.CreateFile directly with a synthesized
// {Get,Create}FileRequestObject.
//
// Path-traversal pipeline mirrors GetAttachment (5 rules) — the only addition is
// .md refusal (Rule 2b for GetFile / Rule 6 for CreateFile), which keeps note
// bodies on /notes/{id} where the lookup-by-UUID model lives.

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
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

// ─── POST /api/v1/files?path=... (Plan 07-34) ─────────────────────────────────
//
// Per CLAUDE.md "plan-vs-investigation contract drift" guidance and the
// 07-32a SUMMARY: POST mirrors GET on /files in using the QUERY-PARAMETER
// pattern (req.Params.Path), NOT a chi catch-all `{path}`. The plan's
// example YAML shows path-segment style — that is rejected for the same
// two reasons that the GET endpoint dropped it: (1) OpenAPI 3.1 has no
// multi-segment path-wildcard syntax, (2) oapi-codegen does not emit chi
// `*` catch-all routes. Co-locating GET + POST under /files keeps the
// surface coherent and lets the frontend hit the same query-param wire
// shape for both.

// buildMultipartBody constructs a *multipart.Reader with one 'file' part
// containing the given filename and bytes. Mirrors buildMultipartRequest
// from attachments_handler_test.go but lives next to the CreateFile tests
// for locality of reasoning.
func buildMultipartBody(t *testing.T, filename string, data []byte) *multipart.Reader {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	return multipart.NewReader(&buf, mw.Boundary())
}

// callCreateFile invokes the CreateFile handler with the given target dir
// (query-parameter binding) and a multipart body holding {filename,data}.
func callCreateFile(t *testing.T, srv *Server, targetDir, filename string, data []byte) CreateFileResponseObject {
	t.Helper()
	mr := buildMultipartBody(t, filename, data)
	resp, err := srv.CreateFile(context.Background(), CreateFileRequestObject{
		Params: CreateFileParams{Path: targetDir},
		Body:   mr,
	})
	if err != nil {
		t.Fatalf("CreateFile error: %v", err)
	}
	return resp
}

// TestCreateFile_HappyPath_RootDir: empty targetDir lands the file at notes/photo.png.
func TestCreateFile_HappyPath_RootDir(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	want := []byte("\x89PNG\r\n\x1a\nfake-image-bytes")
	resp := callCreateFile(t, srv, "", "photo.png", want)

	got201, ok := resp.(CreateFile201JSONResponse)
	if !ok {
		t.Fatalf("expected CreateFile201JSONResponse, got %T", resp)
	}
	if got201.Path != "photo.png" {
		t.Errorf("path: got %q, want %q", got201.Path, "photo.png")
	}
	if got201.Name != "photo.png" {
		t.Errorf("name: got %q, want %q", got201.Name, "photo.png")
	}
	if got201.SizeBytes != int64(len(want)) {
		t.Errorf("size_bytes: got %d, want %d", got201.SizeBytes, len(want))
	}

	abs := filepath.Join(dataDir, "notes", "photo.png")
	if _, err := os.Stat(abs); err != nil {
		t.Errorf("file not at %q: %v", abs, err)
	}
	got, _ := os.ReadFile(abs)
	if !bytes.Equal(got, want) {
		t.Errorf("disk bytes mismatch")
	}
}

// TestCreateFile_HappyPath_SubDir: sub-dir landing.
func TestCreateFile_HappyPath_SubDir(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	if err := os.MkdirAll(filepath.Join(dataDir, "notes", "gallery"), 0o755); err != nil {
		t.Fatalf("mkdir gallery: %v", err)
	}
	want := []byte("\x89PNGsubdir-bytes")
	resp := callCreateFile(t, srv, "gallery", "photo.png", want)

	got201, ok := resp.(CreateFile201JSONResponse)
	if !ok {
		t.Fatalf("expected CreateFile201JSONResponse, got %T", resp)
	}
	if got201.Path != "gallery/photo.png" {
		t.Errorf("path: got %q, want %q", got201.Path, "gallery/photo.png")
	}
	abs := filepath.Join(dataDir, "notes", "gallery", "photo.png")
	if _, err := os.Stat(abs); err != nil {
		t.Errorf("file not at %q: %v", abs, err)
	}
}

// TestCreateFile_CollisionRename: existing photo.png + upload of same → photo-1.png.
func TestCreateFile_CollisionRename(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	galleryDir := filepath.Join(dataDir, "notes", "gallery")
	if err := os.MkdirAll(galleryDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(galleryDir, "photo.png"), []byte("original"), 0o644); err != nil {
		t.Fatalf("write existing: %v", err)
	}

	want := []byte("\x89PNGsecond")
	resp := callCreateFile(t, srv, "gallery", "photo.png", want)
	got201, ok := resp.(CreateFile201JSONResponse)
	if !ok {
		t.Fatalf("expected CreateFile201JSONResponse, got %T", resp)
	}
	if got201.Name != "photo-1.png" {
		t.Errorf("name: got %q, want %q", got201.Name, "photo-1.png")
	}
	if got201.Path != "gallery/photo-1.png" {
		t.Errorf("path: got %q, want %q", got201.Path, "gallery/photo-1.png")
	}
	// Original must be intact.
	orig, _ := os.ReadFile(filepath.Join(galleryDir, "photo.png"))
	if string(orig) != "original" {
		t.Errorf("original file overwritten: got %q", orig)
	}
}

// TestCreateFile_PathTraversal: '..' rejected.
func TestCreateFile_PathTraversal(t *testing.T) {
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)

	for _, p := range []string{"../etc", "..", "sub/../.."} {
		resp := callCreateFile(t, srv, p, "x.bin", []byte("x"))
		got400, ok := resp.(CreateFile400JSONResponse)
		if !ok {
			t.Errorf("path=%q: expected 400, got %T", p, resp)
			continue
		}
		if got400.Code != "invalid_path" {
			t.Errorf("path=%q: code: got %q, want %q", p, got400.Code, "invalid_path")
		}
	}
}

// TestCreateFile_AbsolutePath: leading '/' rejected.
func TestCreateFile_AbsolutePath(t *testing.T) {
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)

	resp := callCreateFile(t, srv, "/etc", "x.bin", []byte("x"))
	got400, ok := resp.(CreateFile400JSONResponse)
	if !ok {
		t.Fatalf("expected 400, got %T", resp)
	}
	if got400.Code != "invalid_path" {
		t.Errorf("code: got %q, want %q", got400.Code, "invalid_path")
	}
}

// TestCreateFile_RejectsMd: .md uploads refused with 400.
func TestCreateFile_RejectsMd(t *testing.T) {
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)

	for _, name := range []string{"note.md", "NOTE.MD", "weird.Md"} {
		resp := callCreateFile(t, srv, "", name, []byte("# secret"))
		got400, ok := resp.(CreateFile400JSONResponse)
		if !ok {
			t.Errorf("filename=%q: expected 400, got %T", name, resp)
			continue
		}
		if got400.Code != "invalid_filename" {
			t.Errorf("filename=%q: code: got %q, want %q", name, got400.Code, "invalid_filename")
		}
	}
}

// TestCreateFile_OverCap: >100MB returns 413.
func TestCreateFile_OverCap(t *testing.T) {
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)

	big := make([]byte, maxAttachmentBytes+1)
	resp := callCreateFile(t, srv, "", "huge.bin", big)
	got413, ok := resp.(CreateFile413JSONResponse)
	if !ok {
		t.Fatalf("expected CreateFile413JSONResponse, got %T", resp)
	}
	if got413.Code != "file_too_large" {
		t.Errorf("code: got %q, want %q", got413.Code, "file_too_large")
	}
}

// TestCreateFile_NonExistentTargetDir: target dir must exist; no auto-mkdir.
func TestCreateFile_NonExistentTargetDir(t *testing.T) {
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)

	resp := callCreateFile(t, srv, "no-such-dir", "x.bin", []byte("x"))
	got400, ok := resp.(CreateFile400JSONResponse)
	if !ok {
		t.Fatalf("expected 400, got %T", resp)
	}
	if got400.Code != "invalid_path" {
		t.Errorf("code: got %q, want %q", got400.Code, "invalid_path")
	}
}

// TestCreateFile_TargetIsFile: target path that is a file (not a dir) → 400.
func TestCreateFile_TargetIsFile(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	// Pre-create a file at notes/existing-file.png — the test then attempts
	// to upload using that file's path as the target dir.
	if err := os.WriteFile(filepath.Join(dataDir, "notes", "existing-file.png"), []byte("old"), 0o644); err != nil {
		t.Fatalf("write existing: %v", err)
	}

	resp := callCreateFile(t, srv, "existing-file.png", "x.bin", []byte("x"))
	got400, ok := resp.(CreateFile400JSONResponse)
	if !ok {
		t.Fatalf("expected 400, got %T", resp)
	}
	if got400.Code != "invalid_path" {
		t.Errorf("code: got %q, want %q", got400.Code, "invalid_path")
	}
}
