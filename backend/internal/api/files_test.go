package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// callServeFile drives the handler actually mounted at GET /api/v1/files.
// The generated GetFile is a stub (see files_stub.go) — asserting against it
// would be testing dead code.
func callServeFile(t *testing.T, srv *Server, relPath string) (*httptest.ResponseRecorder, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/files?path="+url.QueryEscape(relPath), nil)
	rec := httptest.NewRecorder()
	srv.ServeFile(rec, req)
	return rec, rec.Body.String()
}

// fileResponse is the wire shape of a GET /api/v1/files response: the status,
// and the JSON error code when the status is not 200.
type fileResponse struct {
	status int
	code   string
	body   string
}

func callGetFile(t *testing.T, srv *Server, relPath string) fileResponse {
	t.Helper()
	rec, body := callServeFile(t, srv, relPath)
	out := fileResponse{status: rec.Code, body: body}
	if rec.Code != http.StatusOK {
		var e struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal([]byte(body), &e); err != nil {
			t.Fatalf("path=%q: status %d body is not a JSON error: %q", relPath, rec.Code, body)
		}
		out.code = e.Code
	}
	return out
}

// expectFileError asserts the status and error code of a rejected request.
func expectFileError(t *testing.T, got fileResponse, path string, wantStatus int, wantCode string) {
	t.Helper()
	if got.status != wantStatus || got.code != wantCode {
		t.Errorf("path=%q: got %d/%q, want %d/%q", path, got.status, got.code, wantStatus, wantCode)
	}
}

// TestGetFile_HappyPath: a real file under notes/sub/ returns 200 with its bytes.
//
// Exercises the multi-segment path case (sub/photo.png) which is the entire
// reason the investigation chose the query-param approach over a chi catch-all.
func TestGetFile_HappyPath(t *testing.T) {
	t.Parallel()

	srv, dataDir := newAttachmentTestServer(t, nil)

	subDir := filepath.Join(dataDir, "notes", "sub")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}
	want := []byte("\x89PNG\r\n\x1a\nfake-image-bytes")
	if err := os.WriteFile(filepath.Join(subDir, "photo.png"), want, 0o644); err != nil {
		t.Fatalf("write photo.png: %v", err)
	}

	got := callGetFile(t, srv, "sub/photo.png")
	if got.status != http.StatusOK {
		t.Fatalf("status: got %d, want 200 (body %q)", got.status, got.body)
	}
	if got.body != string(want) {
		t.Errorf("body: got %q, want %q", got.body, want)
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
		expectFileError(t, callGetFile(t, srv, p), p, http.StatusBadRequest, "invalid_path")
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

	expectFileError(t, callGetFile(t, srv, "/etc/passwd"), "/etc/passwd",
		http.StatusBadRequest, "invalid_path")
}

// TestGetFile_Symlink: a symlink under notes/ pointing outside the vault
// returns 403 (os.Lstat + Mode()&os.ModeSymlink check, Rule 5).
func TestGetFile_Symlink(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret data"), 0o600); err != nil {
		t.Fatalf("write outside: %v", err)
	}

	notesDir := filepath.Join(dataDir, "notes")
	symlinkPath := filepath.Join(notesDir, "evil.bin")
	if err := os.Symlink(outside, symlinkPath); err != nil {
		t.Skipf("symlinks not supported: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(symlinkPath) })

	expectFileError(t, callGetFile(t, srv, "evil.bin"), "evil.bin",
		http.StatusForbidden, "symlink_rejected")
}

// TestGetFile_NotFound: an absent file returns 404.
func TestGetFile_NotFound(t *testing.T) {
	t.Parallel()
	srv, _ := newAttachmentTestServer(t, nil)

	expectFileError(t, callGetFile(t, srv, "nope.png"), "nope.png",
		http.StatusNotFound, "not_found")
}

// TestGetFile_RootMd_Rejected: .md files (any case) are refused with 404 to
// keep markdown bodies on the /notes/{id} surface (which has the lookup-by-UUID
// + ETag model). Per the plan's TestGetFile_RootMd_Rejected requirement.
func TestGetFile_RootMd_Rejected(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	if err := os.WriteFile(filepath.Join(dataDir, "notes", "leak.md"), []byte("secret note"), 0o644); err != nil {
		t.Fatalf("write md: %v", err)
	}

	for _, p := range []string{"leak.md", "leak.MD", "sub/leak.md"} {
		expectFileError(t, callGetFile(t, srv, p), p, http.StatusNotFound, "not_found")
	}
}

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

func newFilesTestRouter(t *testing.T, srv *Server) *chi.Mux {
	t.Helper()
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/files", srv.ServeFile)
	})
	return r
}

func TestGetFile_SvgContentType(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

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

// TestMoveFile_RaceRepeatIdempotent — when a rapid double-move dispatch
// arrives (e.g. from a race between two arborist drag events), and the first
// move already completed on disk so src is gone and dst exists with the same
// basename, the handler treats the repeat as idempotent and returns 200
// instead of 404.
func TestMoveFile_RaceRepeatIdempotent(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	if err := os.MkdirAll(filepath.Join(dataDir, "notes", "attachments"), 0o755); err != nil {
		t.Fatalf("mkdir attachments: %v", err)
	}
	dstAbs := filepath.Join(dataDir, "notes", "attachments", "foo.png")
	if err := os.WriteFile(dstAbs, []byte("foo-bytes"), 0o644); err != nil {
		t.Fatalf("write dst: %v", err)
	}

	resp := callMoveFile(t, srv, "foo.png", "attachments/foo.png")
	got200, ok := resp.(PostFileMove200JSONResponse)
	if !ok {
		t.Fatalf("expected PostFileMove200JSONResponse (idempotent), got %T", resp)
	}
	if got200.Path != "attachments/foo.png" {
		t.Errorf("path: got %q, want %q", got200.Path, "attachments/foo.png")
	}
	if got200.Name != "foo.png" {
		t.Errorf("name: got %q, want %q", got200.Name, "foo.png")
	}

	if got, _ := os.ReadFile(dstAbs); string(got) != "foo-bytes" {
		t.Errorf("dst mutated by idempotent path: %q", got)
	}

	srcAbs := filepath.Join(dataDir, "notes", "foo.png")
	if _, err := os.Stat(srcAbs); !os.IsNotExist(err) {
		t.Errorf("src still / again exists at %q: err=%v", srcAbs, err)
	}
}

// TestMoveFile_SrcMissingDifferentBasename — the idempotent path fires only
// when basenames match. A rename (different basename) with a missing src and
// a pre-existing dst is NOT a coincidental noop — it returns a real 404.
func TestMoveFile_SrcMissingDifferentBasename(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	if err := os.WriteFile(filepath.Join(dataDir, "notes", "bar.png"), []byte("bar"), 0o644); err != nil {
		t.Fatalf("write dst: %v", err)
	}

	resp := callMoveFile(t, srv, "foo.png", "bar.png")
	got404, ok := resp.(PostFileMove404JSONResponse)
	if !ok {
		t.Fatalf("expected PostFileMove404JSONResponse, got %T", resp)
	}
	if got404.Code != "not_found" {
		t.Errorf("code: got %q, want %q", got404.Code, "not_found")
	}
}

// newAttachmentTestServerWithBroadcaster mirrors newAttachmentTestServer but
// wires a recordingBroadcaster into the Server (CreateFile/DeleteFile/
// PostFileMove/CreateAttachment must broadcast file:* events — the default
// fixture wires nil so these assertions need their own variant).
func newAttachmentTestServerWithBroadcaster(t *testing.T, summaries []notes.NoteSummary) (*Server, string, *recordingBroadcaster) {
	t.Helper()
	dir := t.TempDir()

	notesDir := filepath.Join(dir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idx := &fakeIndexForAttachments{summaries: summaries}
	bc := &recordingBroadcaster{}
	svc := notes.NewService(&fakeFileStore{}, idx, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, bc, logger, dir)
	return srv, dir, bc
}

// TestCreateFile_BroadcastsFileCreated is the failing-first regression:
// a successful upload must broadcast file:created with the
// vault-relative path and final (post-collision-rename) filename.
func TestCreateFile_BroadcastsFileCreated(t *testing.T) {
	t.Parallel()
	srv, _, bc := newAttachmentTestServerWithBroadcaster(t, nil)

	resp := callCreateFile(t, srv, "", "photo.png", []byte("\x89PNGdata"))
	if _, ok := resp.(CreateFile201JSONResponse); !ok {
		t.Fatalf("expected CreateFile201JSONResponse, got %T", resp)
	}

	if got := bc.countByType(notes.EventFileCreated); got != 1 {
		t.Fatalf("file:created count: got %d, want 1", got)
	}
	ev, _ := bc.lastByType(notes.EventFileCreated)
	payload, ok := ev.payload.(map[string]any)
	if !ok {
		t.Fatalf("payload type: got %T, want map[string]any", ev.payload)
	}
	if payload["path"] != "photo.png" {
		t.Errorf("payload[path]: got %v, want %q", payload["path"], "photo.png")
	}
	if payload["name"] != "photo.png" {
		t.Errorf("payload[name]: got %v, want %q", payload["name"], "photo.png")
	}
}

// TestDeleteFile_BroadcastsFileDeleted is the failing-first regression:
// a successful delete must broadcast file:deleted with the
// vault-relative path.
func TestDeleteFile_BroadcastsFileDeleted(t *testing.T) {
	t.Parallel()
	srv, dataDir, bc := newAttachmentTestServerWithBroadcaster(t, nil)

	abs := filepath.Join(dataDir, "notes", "to-delete.png")
	if err := os.WriteFile(abs, []byte("\x89PNGdata"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	resp := callDeleteFile(t, srv, "to-delete.png")
	if _, ok := resp.(DeleteFile204Response); !ok {
		t.Fatalf("expected DeleteFile204Response, got %T", resp)
	}

	if got := bc.countByType(notes.EventFileDeleted); got != 1 {
		t.Fatalf("file:deleted count: got %d, want 1", got)
	}
	ev, _ := bc.lastByType(notes.EventFileDeleted)
	payload, ok := ev.payload.(map[string]any)
	if !ok {
		t.Fatalf("payload type: got %T, want map[string]any", ev.payload)
	}
	if payload["path"] != "to-delete.png" {
		t.Errorf("payload[path]: got %v, want %q", payload["path"], "to-delete.png")
	}
}

// TestPostFileMove_BroadcastsFileMoved is the failing-first regression:
// a successful (real, non-idempotent) move must broadcast
// file:moved with old_path/new_path.
func TestPostFileMove_BroadcastsFileMoved(t *testing.T) {
	t.Parallel()
	srv, dataDir, bc := newAttachmentTestServerWithBroadcaster(t, nil)

	if err := os.MkdirAll(filepath.Join(dataDir, "notes", "attachments"), 0o755); err != nil {
		t.Fatalf("mkdir attachments: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "notes", "foo.png"), []byte("foo-bytes"), 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}

	resp := callMoveFile(t, srv, "foo.png", "attachments/foo.png")
	if _, ok := resp.(PostFileMove200JSONResponse); !ok {
		t.Fatalf("expected PostFileMove200JSONResponse, got %T", resp)
	}

	if got := bc.countByType(notes.EventFileMoved); got != 1 {
		t.Fatalf("file:moved count: got %d, want 1", got)
	}
	ev, _ := bc.lastByType(notes.EventFileMoved)
	payload, ok := ev.payload.(map[string]any)
	if !ok {
		t.Fatalf("payload type: got %T, want map[string]any", ev.payload)
	}
	if payload["old_path"] != "foo.png" {
		t.Errorf("payload[old_path]: got %v, want %q", payload["old_path"], "foo.png")
	}
	if payload["new_path"] != "attachments/foo.png" {
		t.Errorf("payload[new_path]: got %v, want %q", payload["new_path"], "attachments/foo.png")
	}
}

// TestPostFileMove_NotFoundAndCollision_NoBroadcast verifies the 404
// (src missing) and 409 (dst exists) branches never broadcast file:moved.
func TestPostFileMove_NotFoundAndCollision_NoBroadcast(t *testing.T) {
	t.Parallel()

	t.Run("404 not found", func(t *testing.T) {
		t.Parallel()
		srv, _, bc := newAttachmentTestServerWithBroadcaster(t, nil)

		resp := callMoveFile(t, srv, "missing.png", "dst.png")
		if _, ok := resp.(PostFileMove404JSONResponse); !ok {
			t.Fatalf("expected PostFileMove404JSONResponse, got %T", resp)
		}
		if got := bc.countByType(notes.EventFileMoved); got != 0 {
			t.Errorf("file:moved count: got %d, want 0", got)
		}
	})

	t.Run("409 collision", func(t *testing.T) {
		t.Parallel()
		srv, dataDir, bc := newAttachmentTestServerWithBroadcaster(t, nil)

		if err := os.WriteFile(filepath.Join(dataDir, "notes", "src.png"), []byte("src"), 0o644); err != nil {
			t.Fatalf("write src: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dataDir, "notes", "dst.png"), []byte("dst"), 0o644); err != nil {
			t.Fatalf("write dst: %v", err)
		}

		resp := callMoveFile(t, srv, "src.png", "dst.png")
		if _, ok := resp.(PostFileMove409JSONResponse); !ok {
			t.Fatalf("expected PostFileMove409JSONResponse, got %T", resp)
		}
		if got := bc.countByType(notes.EventFileMoved); got != 0 {
			t.Errorf("file:moved count: got %d, want 0", got)
		}
	})
}

// TestCreateAttachment_BroadcastsFileCreated is the failing-first
// regression: a successful attachment upload must broadcast file:created
// with the note-parent-relative attachment path and final filename.
func TestCreateAttachment_BroadcastsFileCreated(t *testing.T) {
	t.Parallel()
	noteID := uuid.New()
	summaries := []notes.NoteSummary{
		{ID: noteID, Path: "root.md", Title: "Root", UpdatedAt: time.Now()},
	}
	srv, _, bc := newAttachmentTestServerWithBroadcaster(t, summaries)

	resp := callCreateAttachment(t, srv, noteID.String(), "hello.png", []byte("\x89PNGdata"))
	if _, ok := resp.(CreateAttachment200JSONResponse); !ok {
		t.Fatalf("expected CreateAttachment200JSONResponse, got %T", resp)
	}

	if got := bc.countByType(notes.EventFileCreated); got != 1 {
		t.Fatalf("file:created count: got %d, want 1", got)
	}
	ev, _ := bc.lastByType(notes.EventFileCreated)
	payload, ok := ev.payload.(map[string]any)
	if !ok {
		t.Fatalf("payload type: got %T, want map[string]any", ev.payload)
	}
	if payload["path"] != "attachments/hello.png" {
		t.Errorf("payload[path]: got %v, want %q", payload["path"], "attachments/hello.png")
	}
	if payload["name"] != "hello.png" {
		t.Errorf("payload[name]: got %v, want %q", payload["name"], "hello.png")
	}
}
