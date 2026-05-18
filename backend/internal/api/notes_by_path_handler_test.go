package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// byPathIndex is a test-only notes.Index that returns a canned record
// for a known canonical path and ErrNotFound otherwise. Embeds the
// fakeIndex no-op stubs so the port stays satisfied as new methods
// are added.
type byPathIndex struct {
	fakeIndex
	wantPath string
	rec      notes.NoteRecord
}

func (b *byPathIndex) LookupByPath(_ context.Context, p string) (notes.NoteRecord, error) {
	if p == b.wantPath {
		return b.rec, nil
	}
	return notes.NoteRecord{}, notes.ErrNotFound
}

func setupByPathServer(t *testing.T, idx notes.Index) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, "")
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r)
}

func getByPath(t *testing.T, ts *httptest.Server, rawPath string) (*http.Response, []byte) {
	t.Helper()
	u := ts.URL + "/api/v1/notes/by-path?path=" + url.QueryEscape(rawPath)
	resp, err := http.Get(u)
	if err != nil {
		t.Fatalf("GET %s: %v", u, err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp, body
}

// TestGetNoteByPath_HappyPath_200 — known path resolves to its
// NoteSummary; response shape matches the GetNotes wire schema.
func TestGetNoteByPath_HappyPath_200(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	mtime := time.Date(2026, 5, 17, 10, 0, 0, 0, time.UTC)
	idx := &byPathIndex{
		wantPath: "projects/alpha.md",
		rec: notes.NoteRecord{
			ID:        id,
			Path:      "projects/alpha.md",
			Title:     "Alpha",
			MTimeUnix: mtime.Unix(),
		},
	}
	ts := setupByPathServer(t, idx)
	defer ts.Close()

	resp, body := getByPath(t, ts, "projects/alpha.md")
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got NoteSummary
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if uuid.UUID(got.Id) != id {
		t.Errorf("Id: got %v, want %v", got.Id, id)
	}
	if got.Path != "projects/alpha.md" {
		t.Errorf("Path: got %q, want %q", got.Path, "projects/alpha.md")
	}
	if got.Title != "Alpha" {
		t.Errorf("Title: got %q, want %q", got.Title, "Alpha")
	}
	if got.UpdatedAt.Unix() != mtime.Unix() {
		t.Errorf("UpdatedAt: got %v, want %v", got.UpdatedAt, mtime)
	}
}

// TestGetNoteByPath_HappyPath_CaseInsensitive_200 — input
// "Projects/Alpha.md" canonicalizes to "projects/alpha.md" so the
// lookup still hits.
func TestGetNoteByPath_HappyPath_CaseInsensitive_200(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	mtime := time.Date(2026, 5, 17, 10, 0, 0, 0, time.UTC)
	idx := &byPathIndex{
		wantPath: "projects/alpha.md",
		rec: notes.NoteRecord{
			ID:        id,
			Path:      "projects/alpha.md",
			Title:     "Alpha",
			MTimeUnix: mtime.Unix(),
		},
	}
	ts := setupByPathServer(t, idx)
	defer ts.Close()

	resp, _ := getByPath(t, ts, "Projects/Alpha.md")
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200 (case-fold)", resp.StatusCode)
	}
}

// TestGetNoteByPath_NotFound_404 — path with no matching note returns
// 404 + Error{code: "not_found"}.
func TestGetNoteByPath_NotFound_404(t *testing.T) {
	t.Parallel()
	idx := &byPathIndex{wantPath: "this/does/not/match.md"}
	ts := setupByPathServer(t, idx)
	defer ts.Close()

	resp, body := getByPath(t, ts, "missing/note.md")
	if resp.StatusCode != 404 {
		t.Fatalf("status: got %d, want 404; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "not_found" {
		t.Errorf("Code: got %q, want %q", got.Code, "not_found")
	}
}

// TestGetNoteByPath_PathTraversal_400 — `../etc/passwd` rejected.
func TestGetNoteByPath_PathTraversal_400(t *testing.T) {
	t.Parallel()
	idx := &byPathIndex{}
	ts := setupByPathServer(t, idx)
	defer ts.Close()

	resp, body := getByPath(t, ts, "../etc/passwd")
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "invalid_path" {
		t.Errorf("Code: got %q, want %q", got.Code, "invalid_path")
	}
}

// TestGetNoteByPath_AbsolutePath_400 — `/foo.md` rejected (POSIX abs).
func TestGetNoteByPath_AbsolutePath_400(t *testing.T) {
	t.Parallel()
	idx := &byPathIndex{}
	ts := setupByPathServer(t, idx)
	defer ts.Close()

	resp, body := getByPath(t, ts, "/foo.md")
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "invalid_path" {
		t.Errorf("Code: got %q, want %q", got.Code, "invalid_path")
	}
}

// TestGetNoteByPath_NonMarkdown_400 — `foo.txt` rejected (deep-links
// target notes only).
func TestGetNoteByPath_NonMarkdown_400(t *testing.T) {
	t.Parallel()
	idx := &byPathIndex{}
	ts := setupByPathServer(t, idx)
	defer ts.Close()

	resp, body := getByPath(t, ts, "foo.txt")
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "invalid_path" {
		t.Errorf("Code: got %q, want %q", got.Code, "invalid_path")
	}
}

// TestGetNoteByPath_EmptyPath_400 — empty `path=` is rejected
// upstream by oapi-codegen's required-param validator (the spec
// declares the param required + minLength 1). We assert the wrapper
// returns 4xx rather than a 500 — exact body shape is the generated
// validator's, not our api.Error.
func TestGetNoteByPath_EmptyPath_400(t *testing.T) {
	t.Parallel()
	idx := &byPathIndex{}
	ts := setupByPathServer(t, idx)
	defer ts.Close()

	resp, _ := getByPath(t, ts, "")
	if resp.StatusCode < 400 || resp.StatusCode >= 500 {
		t.Fatalf("status: got %d, want 4xx", resp.StatusCode)
	}
}
