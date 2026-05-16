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
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
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

// ─── R7a: SVG / PNG Content-Type detection (Plan 07-38) ───────────────────────
//
// These tests exercise the HTTP layer (not the strict-handler method directly)
// because the Content-Type header is the property under test, and the
// generated wrapper hard-codes "application/octet-stream". The fix is a
// manual chi route override registered in app/lifecycle.go that calls
// s.ServeFile(w, r); these tests hit that route via httptest.

// newFilesTestRouter wires a chi router with the manual ServeFile override
// on GET /api/v1/files, mirroring the production lifecycle.go pattern.
func newFilesTestRouter(t *testing.T, srv *Server) *chi.Mux {
	t.Helper()
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		// Plan 07-38 R7a: same last-registration-wins pattern as /ws — manual
		// handler overrides the generated wrapper so Content-Type is dynamic.
		r.Get("/files", srv.ServeFile)
	})
	return r
}

func TestGetFile_SvgContentType(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	// A minimal valid SVG. http.DetectContentType on this returns
	// "text/xml; charset=utf-8" — which browsers refuse for <img>. The
	// fix is an extension-based override.
	svg := []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>`)
	if err := os.WriteFile(filepath.Join(dataDir, "notes", "icon.svg"), svg, 0o644); err != nil {
		t.Fatalf("write svg: %v", err)
	}

	r := newFilesTestRouter(t, srv)
	ts := httptest.NewServer(r)
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/v1/files?path=icon.svg")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "image/svg+xml" {
		t.Errorf("Content-Type: got %q, want %q", ct, "image/svg+xml")
	}
	body, _ := io.ReadAll(resp.Body)
	if !bytes.Equal(body, svg) {
		t.Errorf("body mismatch")
	}
}

func TestGetFile_PngContentType(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	// PNG magic bytes — http.DetectContentType returns "image/png" for these.
	png := []byte("\x89PNG\r\n\x1a\nrest-of-the-png-bytes-which-do-not-matter")
	if err := os.WriteFile(filepath.Join(dataDir, "notes", "photo.png"), png, 0o644); err != nil {
		t.Fatalf("write png: %v", err)
	}

	r := newFilesTestRouter(t, srv)
	ts := httptest.NewServer(r)
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/v1/files?path=photo.png")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type: got %q, want %q", ct, "image/png")
	}
}

func TestGetFile_HttpRoute_PathTraversal(t *testing.T) {
	// HTTP-level smoke test: traversal still rejected through the manual
	// route (defense-in-depth check that the manual handler runs the same
	// 5-rule pipeline as the strict handler).
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)
	r := newFilesTestRouter(t, srv)
	ts := httptest.NewServer(r)
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/v1/files?path=../../etc/passwd")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != 400 {
		t.Errorf("status: got %d, want 400", resp.StatusCode)
	}
}

// ─── R7b: DELETE /api/v1/files + POST /api/v1/files/move ──────────────────────

func callDeleteFile(t *testing.T, srv *Server, relPath string) DeleteFileResponseObject {
	t.Helper()
	resp, err := srv.DeleteFile(context.Background(), DeleteFileRequestObject{
		Params: DeleteFileParams{Path: relPath},
	})
	if err != nil {
		t.Fatalf("DeleteFile error: %v", err)
	}
	return resp
}

func TestDeleteFile_HappyPath(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	abs := filepath.Join(dataDir, "notes", "to-delete.png")
	if err := os.WriteFile(abs, []byte("\x89PNGdata"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	resp := callDeleteFile(t, srv, "to-delete.png")
	if _, ok := resp.(DeleteFile204Response); !ok {
		t.Fatalf("expected DeleteFile204Response, got %T", resp)
	}
	if _, err := os.Stat(abs); !os.IsNotExist(err) {
		t.Errorf("file still exists: err=%v", err)
	}
}

func TestDeleteFile_RefusesMd(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	if err := os.WriteFile(filepath.Join(dataDir, "notes", "note.md"), []byte("# x"), 0o644); err != nil {
		t.Fatalf("write md: %v", err)
	}

	for _, p := range []string{"note.md", "NOTE.MD"} {
		resp := callDeleteFile(t, srv, p)
		got400, ok := resp.(DeleteFile400JSONResponse)
		if !ok {
			t.Errorf("path=%q: expected DeleteFile400JSONResponse, got %T", p, resp)
			continue
		}
		// Either "invalid_path" (for md refusal) is acceptable as long as
		// it's a 400 — the contract just says "no md files".
		if got400.Code == "" {
			t.Errorf("path=%q: empty error code", p)
		}
	}
}

func TestDeleteFile_NotFound(t *testing.T) {
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)

	resp := callDeleteFile(t, srv, "nonexistent.png")
	got404, ok := resp.(DeleteFile404JSONResponse)
	if !ok {
		t.Fatalf("expected DeleteFile404JSONResponse, got %T", resp)
	}
	if got404.Code != "not_found" {
		t.Errorf("code: got %q, want %q", got404.Code, "not_found")
	}
}

func TestDeleteFile_RefusesDirectory(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	if err := os.MkdirAll(filepath.Join(dataDir, "notes", "sub"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	resp := callDeleteFile(t, srv, "sub")
	got400, ok := resp.(DeleteFile400JSONResponse)
	if !ok {
		t.Fatalf("expected DeleteFile400JSONResponse, got %T", resp)
	}
	if got400.Code != "invalid_path" {
		t.Errorf("code: got %q, want %q", got400.Code, "invalid_path")
	}
}

func TestDeleteFile_PathTraversal(t *testing.T) {
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)

	resp := callDeleteFile(t, srv, "../../../etc/passwd")
	got400, ok := resp.(DeleteFile400JSONResponse)
	if !ok {
		t.Fatalf("expected 400, got %T", resp)
	}
	if got400.Code != "invalid_path" {
		t.Errorf("code: got %q, want %q", got400.Code, "invalid_path")
	}
}

func callMoveFile(t *testing.T, srv *Server, src, dst string) PostFileMoveResponseObject {
	t.Helper()
	body := PostFileMoveJSONRequestBody{SrcPath: src, DstPath: dst}
	resp, err := srv.PostFileMove(context.Background(), PostFileMoveRequestObject{
		Body: &body,
	})
	if err != nil {
		t.Fatalf("PostFileMove error: %v", err)
	}
	return resp
}

func TestMoveFile_HappyPath(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	srcAbs := filepath.Join(dataDir, "notes", "a.png")
	if err := os.WriteFile(srcAbs, []byte("\x89PNGmoved"), 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}

	resp := callMoveFile(t, srv, "a.png", "b.png")
	got200, ok := resp.(PostFileMove200JSONResponse)
	if !ok {
		t.Fatalf("expected PostFileMove200JSONResponse, got %T", resp)
	}
	if got200.Path != "b.png" {
		t.Errorf("path: got %q, want %q", got200.Path, "b.png")
	}
	if got200.Name != "b.png" {
		t.Errorf("name: got %q, want %q", got200.Name, "b.png")
	}
	if _, err := os.Stat(srcAbs); !os.IsNotExist(err) {
		t.Errorf("src still exists: err=%v", err)
	}
	dstAbs := filepath.Join(dataDir, "notes", "b.png")
	if _, err := os.Stat(dstAbs); err != nil {
		t.Errorf("dst missing: %v", err)
	}
}

func TestMoveFile_RefusesOverwrite(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	if err := os.WriteFile(filepath.Join(dataDir, "notes", "a.png"), []byte("a-bytes"), 0o644); err != nil {
		t.Fatalf("write a: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "notes", "b.png"), []byte("b-bytes"), 0o644); err != nil {
		t.Fatalf("write b: %v", err)
	}

	resp := callMoveFile(t, srv, "a.png", "b.png")
	got409, ok := resp.(PostFileMove409JSONResponse)
	if !ok {
		t.Fatalf("expected PostFileMove409JSONResponse, got %T", resp)
	}
	if got409.Code != "already_exists" {
		t.Errorf("code: got %q, want %q", got409.Code, "already_exists")
	}
	// Both files intact.
	if got, _ := os.ReadFile(filepath.Join(dataDir, "notes", "a.png")); string(got) != "a-bytes" {
		t.Errorf("a.png mutated: %s", got)
	}
	if got, _ := os.ReadFile(filepath.Join(dataDir, "notes", "b.png")); string(got) != "b-bytes" {
		t.Errorf("b.png mutated: %s", got)
	}
}

func TestMoveFile_RefusesMdSrc(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)
	if err := os.WriteFile(filepath.Join(dataDir, "notes", "note.md"), []byte("# x"), 0o644); err != nil {
		t.Fatalf("write md: %v", err)
	}
	resp := callMoveFile(t, srv, "note.md", "renamed.md")
	got400, ok := resp.(PostFileMove400JSONResponse)
	if !ok {
		t.Fatalf("expected 400, got %T", resp)
	}
	if got400.Code == "" {
		t.Errorf("empty code")
	}
}

func TestMoveFile_SrcNotFound(t *testing.T) {
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)
	resp := callMoveFile(t, srv, "nonexistent.png", "b.png")
	got404, ok := resp.(PostFileMove404JSONResponse)
	if !ok {
		t.Fatalf("expected 404, got %T", resp)
	}
	if got404.Code != "not_found" {
		t.Errorf("code: got %q, want %q", got404.Code, "not_found")
	}
}

func TestMoveFile_PathTraversal(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)
	if err := os.WriteFile(filepath.Join(dataDir, "notes", "ok.png"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	cases := [][2]string{
		{"../../etc/passwd", "ok.png"},
		{"ok.png", "../../etc/evil.png"},
	}
	for _, c := range cases {
		resp := callMoveFile(t, srv, c[0], c[1])
		got400, ok := resp.(PostFileMove400JSONResponse)
		if !ok {
			t.Errorf("src=%q dst=%q: expected 400, got %T", c[0], c[1], resp)
			continue
		}
		if got400.Code != "invalid_path" {
			t.Errorf("src=%q dst=%q: code: got %q, want %q", c[0], c[1], got400.Code, "invalid_path")
		}
	}
}
