package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

type fakeIndex struct {
	listResult []notes.NoteSummary
	listErr    error
}

func (f *fakeIndex) Upsert(_ context.Context, _ notes.NoteRecord) error { return nil }
func (f *fakeIndex) Delete(_ context.Context, _ uuid.UUID) error        { return nil }
func (f *fakeIndex) List(_ context.Context) ([]notes.NoteSummary, error) {
	return f.listResult, f.listErr
}

// Extended notes.Index port methods not exercised in this package; no-ops keep
// the port satisfied at compile time.
func (f *fakeIndex) LookupByPath(_ context.Context, _ string) (notes.NoteRecord, error) {
	return notes.NoteRecord{}, notes.ErrNotFound
}
func (f *fakeIndex) MovePathPrefix(_ context.Context, _, _ string) (int, error) { return 0, nil }
func (f *fakeIndex) DeleteByPathPrefix(_ context.Context, _ string) (int, error) {
	return 0, nil
}

func (f *fakeIndex) ListTags(_ context.Context) ([]notes.TagWithCount, error) {
	return []notes.TagWithCount{}, nil
}
func (f *fakeIndex) SyncTags(_ context.Context, _ uuid.UUID, _ []string) error { return nil }

func (f *fakeIndex) SyncBacklinks(_ context.Context, _ uuid.UUID, _ string,
	_ []markdown.WikiLinkRef, _ *notes.Registry, _ []byte,
) error {
	return nil
}

func (f *fakeIndex) NotesByTag(_ context.Context, _ string) ([]notes.NoteSummary, error) {
	return []notes.NoteSummary{}, nil
}

func (f *fakeIndex) RenameTag(_ context.Context, _, _ string) ([]uuid.UUID, error) {
	return nil, nil
}

func (f *fakeIndex) DeleteTag(_ context.Context, _ string) ([]uuid.UUID, error) {
	return nil, nil
}

func (f *fakeIndex) SourcesByBacklinkTitle(_ context.Context, _ string) ([]notes.NoteSummary, error) {
	return []notes.NoteSummary{}, nil
}

func (f *fakeIndex) UpdateBacklinksTargetTitle(_ context.Context, _, _ string, _ *uuid.UUID) error {
	return nil
}

func (f *fakeIndex) GetBacklinks(_ context.Context, _ uuid.UUID) ([]notes.BacklinkRow, error) {
	return []notes.BacklinkRow{}, nil
}

func (f *fakeIndex) SearchTitles(_ context.Context, _ string, _ int) ([]notes.SearchResult, error) {
	return []notes.SearchResult{}, nil
}

func (f *fakeIndex) SearchFTS(_ context.Context, _ string, _ []string, _ int, _ string) ([]notes.SearchHit, error) {
	return []notes.SearchHit{}, nil
}

func setupGetNotesServer(t *testing.T, idx notes.Index) *httptest.Server {
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

// TestGetNotes_Empty_ReturnsEmptyArray — index returns nil; the wire
// format is `{notes: []}` (NOT `{notes: null}`).
func TestGetNotes_Empty_ReturnsEmptyArray(t *testing.T) {
	t.Parallel()
	idx := &fakeIndex{listResult: nil}
	ts := setupGetNotesServer(t, idx)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/notes")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}

	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	notesField, ok := raw["notes"]
	if !ok {
		t.Fatalf("notes key missing; body=%s", body)
	}
	arr, ok := notesField.([]any)
	if !ok {
		t.Fatalf("notes: got %T, want []any (must be `[]` not `null`); body=%s", notesField, body)
	}
	if len(arr) != 0 {
		t.Errorf("notes len: got %d, want 0", len(arr))
	}
}

// TestGetNotes_PopulatedFromIndex — index returns 3 summaries; wire
// format has 3 entries with correct fields.
func TestGetNotes_PopulatedFromIndex(t *testing.T) {
	t.Parallel()
	id1, id2, id3 := uuid.New(), uuid.New(), uuid.New()
	t1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	idx := &fakeIndex{listResult: []notes.NoteSummary{
		{ID: id1, Path: "a.md", Title: "Alpha", UpdatedAt: t1},
		{ID: id2, Path: "b.md", Title: "Bravo", UpdatedAt: t1},
		{ID: id3, Path: "c.md", Title: "Charlie", UpdatedAt: t1},
	}}
	ts := setupGetNotesServer(t, idx)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/notes")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d; body=%s", resp.StatusCode, body)
	}
	var got NoteList
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if len(got.Notes) != 3 {
		t.Fatalf("len: got %d, want 3; body=%s", len(got.Notes), body)
	}
	if uuid.UUID(got.Notes[0].Id) != id1 {
		t.Errorf("[0].Id: got %v, want %v", got.Notes[0].Id, id1)
	}
	if got.Notes[1].Path != "b.md" {
		t.Errorf("[1].Path: got %q, want %q", got.Notes[1].Path, "b.md")
	}
	if got.Notes[2].Title != "Charlie" {
		t.Errorf("[2].Title: got %q, want %q", got.Notes[2].Title, "Charlie")
	}
}

// TestGetNotes_NilIndex_FallsBackToEmpty — nil index → empty list, NOT 503.
func TestGetNotes_NilIndex_FallsBackToEmpty(t *testing.T) {
	t.Parallel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, nil, logger)
	srv := NewServer(svc, logger)
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	ts := httptest.NewServer(r)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/notes")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200 (nil-index falls back to empty); body=%s",
			resp.StatusCode, body)
	}
	var got NoteList
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Notes == nil || len(got.Notes) != 0 {
		t.Errorf("notes: got %v, want []", got.Notes)
	}
}

// TestGetNotes_OrderedByPathASC — the API does NOT re-sort; the index
// returns rows in path-ASC order (per the *Indexer.List contract);
// the handler preserves that order.
func TestGetNotes_OrderedByPathASC(t *testing.T) {
	t.Parallel()
	t1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	idx := &fakeIndex{listResult: []notes.NoteSummary{
		{ID: uuid.New(), Path: "a.md", Title: "A", UpdatedAt: t1},
		{ID: uuid.New(), Path: "m.md", Title: "M", UpdatedAt: t1},
		{ID: uuid.New(), Path: "z.md", Title: "Z", UpdatedAt: t1},
	}}
	ts := setupGetNotesServer(t, idx)
	defer ts.Close()
	resp, _ := http.Get(ts.URL + "/api/v1/notes")
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var got NoteList
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	want := []string{"a.md", "m.md", "z.md"}
	for i, w := range want {
		if got.Notes[i].Path != w {
			t.Errorf("[%d]: got %q, want %q", i, got.Notes[i].Path, w)
		}
	}
}

// TestGetNotes_IndexErr_Returns500_GenericMessage — index.List error maps to
// 500 with a generic wire message (never leak the wrapped chain).
func TestGetNotes_IndexErr_Returns500_GenericMessage(t *testing.T) {
	t.Parallel()
	idx := &fakeIndex{listErr: errors.New("internal sqlite trouble: /abs/path/to/db")}
	ts := setupGetNotesServer(t, idx)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/notes")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 500 {
		t.Fatalf("status: got %d, want 500; body=%s", resp.StatusCode, body)
	}

	if string(body) == "" {
		t.Errorf("body empty")
	}
}

type realIndex struct {
	byPath    map[string]notes.NoteRecord
	byID      map[uuid.UUID]notes.NoteRecord
	upsertErr error

	backlinks map[string][]notes.NoteSummary
}

func newRealIndex() *realIndex {
	return &realIndex{
		byPath:    make(map[string]notes.NoteRecord),
		byID:      make(map[uuid.UUID]notes.NoteRecord),
		backlinks: make(map[string][]notes.NoteSummary),
	}
}

func (r *realIndex) setBacklink(targetTitle string, source notes.NoteSummary) {
	r.backlinks[targetTitle] = append(r.backlinks[targetTitle], source)
}

func (r *realIndex) Upsert(_ context.Context, rec notes.NoteRecord) error {
	if r.upsertErr != nil {
		return r.upsertErr
	}
	if existing, ok := r.byPath[rec.Path]; ok && existing.ID != rec.ID {
		return notes.ErrCaseCollision
	}
	if old, ok := r.byID[rec.ID]; ok && old.Path != rec.Path {
		delete(r.byPath, old.Path)
	}
	r.byPath[rec.Path] = rec
	r.byID[rec.ID] = rec
	return nil
}

func (r *realIndex) Delete(_ context.Context, id uuid.UUID) error {
	if rec, ok := r.byID[id]; ok {
		delete(r.byPath, rec.Path)
		delete(r.byID, id)
	}
	return nil
}

func (r *realIndex) List(_ context.Context) ([]notes.NoteSummary, error) {
	out := make([]notes.NoteSummary, 0, len(r.byID))
	for _, rec := range r.byID {
		out = append(out, notes.NoteSummary{
			ID:        rec.ID,
			Path:      rec.Path,
			Title:     rec.Title,
			UpdatedAt: time.Unix(rec.MTimeUnix, 0).UTC(),
		})
	}
	return out, nil
}

func (r *realIndex) LookupByPath(_ context.Context, p string) (notes.NoteRecord, error) {
	if rec, ok := r.byPath[p]; ok {
		return rec, nil
	}
	return notes.NoteRecord{}, notes.ErrNotFound
}

func (r *realIndex) MovePathPrefix(_ context.Context, oldPrefix, newPrefix string) (int, error) {
	for p := range r.byPath {
		if strings.HasPrefix(p, newPrefix) && !strings.HasPrefix(p, oldPrefix) {
			return 0, notes.ErrCaseCollision
		}
	}
	moves := []notes.NoteRecord{}
	for p, rec := range r.byPath {
		if strings.HasPrefix(p, oldPrefix) {
			moves = append(moves, rec)
		}
	}
	for _, rec := range moves {
		newPath := newPrefix + strings.TrimPrefix(rec.Path, oldPrefix)
		delete(r.byPath, rec.Path)
		rec.Path = newPath
		r.byPath[newPath] = rec
		r.byID[rec.ID] = rec
	}
	return len(moves), nil
}

func (r *realIndex) ListTags(_ context.Context) ([]notes.TagWithCount, error) {
	return []notes.TagWithCount{}, nil
}
func (r *realIndex) SyncTags(_ context.Context, _ uuid.UUID, _ []string) error { return nil }
func (r *realIndex) SyncBacklinks(_ context.Context, _ uuid.UUID, _ string,
	_ []markdown.WikiLinkRef, _ *notes.Registry, _ []byte,
) error {
	return nil
}

func (r *realIndex) NotesByTag(_ context.Context, _ string) ([]notes.NoteSummary, error) {
	return []notes.NoteSummary{}, nil
}

func (r *realIndex) RenameTag(_ context.Context, _, _ string) ([]uuid.UUID, error) {
	return nil, nil
}

func (r *realIndex) DeleteTag(_ context.Context, _ string) ([]uuid.UUID, error) {
	return nil, nil
}

// Paths are re-resolved from the live record, because the real query joins the
// notes table and Service.Move has already upserted the new path by the time
// the rewrite pass runs. Returning the path captured at setBacklink time would
// make a moved note's own referrer row point at a file that no longer exists.
func (r *realIndex) SourcesByBacklinkTitle(_ context.Context, title string) ([]notes.NoteSummary, error) {
	srcs, ok := r.backlinks[title]
	if !ok {
		return []notes.NoteSummary{}, nil
	}
	out := make([]notes.NoteSummary, 0, len(srcs))
	for _, s := range srcs {
		if live, found := r.byID[s.ID]; found {
			s.Path = live.Path
			s.Title = live.Title
		}
		out = append(out, s)
	}
	return out, nil
}

func (r *realIndex) UpdateBacklinksTargetTitle(_ context.Context, _, _ string, _ *uuid.UUID) error {
	return nil
}

func (r *realIndex) GetBacklinks(_ context.Context, _ uuid.UUID) ([]notes.BacklinkRow, error) {
	return []notes.BacklinkRow{}, nil
}

func (r *realIndex) SearchTitles(_ context.Context, _ string, _ int) ([]notes.SearchResult, error) {
	return []notes.SearchResult{}, nil
}

func (r *realIndex) SearchFTS(_ context.Context, _ string, _ []string, _ int, _ string) ([]notes.SearchHit, error) {
	return []notes.SearchHit{}, nil
}

func (r *realIndex) DeleteByPathPrefix(_ context.Context, prefix string) (int, error) {
	matched := []notes.NoteRecord{}
	for p, rec := range r.byPath {
		if prefix == "" || p == prefix || strings.HasPrefix(p, prefix+"/") {
			matched = append(matched, rec)
		}
	}
	for _, rec := range matched {
		delete(r.byPath, rec.Path)
		delete(r.byID, rec.ID)
	}
	return len(matched), nil
}

func setupRealFSServer(t *testing.T) (*httptest.Server, *notes.Service, string, *realIndex) {
	t.Helper()
	dataDir := t.TempDir()
	notesDir := filepath.Join(dataDir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("MkdirAll notesDir: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, ".trash"), 0o755); err != nil {
		t.Fatalf("MkdirAll trashDir: %v", err)
	}
	store := fsstore.NewStore(notesDir)
	idx := newRealIndex()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := notes.NewService(store, idx, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, "")
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r), svc, notesDir, idx
}

func mustPostJSON(t *testing.T, ts *httptest.Server, path string, body string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+path, bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	respBody, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp, respBody
}

func mustDelete(t *testing.T, ts *httptest.Server, path string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, ts.URL+path, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE %s: %v", path, err)
	}
	respBody, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp, respBody
}

// TestPostNotes_HappyPath_201 — POST /notes with parent_path="" and a
// title creates a note at <title>.md and returns 201 with the new
// NoteSummary.
func TestPostNotes_HappyPath_201(t *testing.T) {
	t.Parallel()
	ts, _, root, idx := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"","title":"alpha"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("status: got %d, want 201; body=%s", resp.StatusCode, body)
	}
	var got NoteSummary
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Path != "alpha.md" {
		t.Errorf("Path: got %q, want %q", got.Path, "alpha.md")
	}
	if got.Title != "alpha" {
		t.Errorf("Title: got %q, want %q", got.Title, "alpha")
	}
	if uuid.UUID(got.Id) == uuid.Nil {
		t.Errorf("Id: got nil UUID")
	}
	if got.UpdatedAt.IsZero() {
		t.Errorf("UpdatedAt: zero")
	}

	if _, err := os.Stat(filepath.Join(root, "alpha.md")); err != nil {
		t.Errorf("file not on disk: %v", err)
	}

	if _, ok := idx.byPath["alpha.md"]; !ok {
		t.Errorf("index does not have alpha.md row")
	}
}

// TestPostNotes_InFolder_201 — parent_path points to an existing folder.
func TestPostNotes_InFolder_201(t *testing.T) {
	t.Parallel()
	ts, _, root, _ := setupRealFSServer(t)
	defer ts.Close()

	if err := os.Mkdir(filepath.Join(root, "projects"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"projects","title":"alpha"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("status: got %d, want 201; body=%s", resp.StatusCode, body)
	}
	var got NoteSummary
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Path != "projects/alpha.md" {
		t.Errorf("Path: got %q, want %q", got.Path, "projects/alpha.md")
	}
}

// TestPostNotes_NilBody_400 — an empty body returns 400 invalid_request.
func TestPostNotes_NilBody_400(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/notes", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()

	if resp.StatusCode < 400 || resp.StatusCode >= 500 {
		t.Fatalf("status: got %d, want 4xx; body=%s", resp.StatusCode, body)
	}
}

// TestPostNotes_Collision_409 — creating two notes with the same name
// returns 409 case_collision on the second.
func TestPostNotes_Collision_409(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"","title":"alpha"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("first POST: got %d, want 201; body=%s", resp.StatusCode, body)
	}
	resp, body = mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"","title":"alpha"}`)
	if resp.StatusCode != 409 {
		t.Fatalf("second POST: got %d, want 409; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "case_collision" {
		t.Errorf("Code: got %q, want %q", got.Code, "case_collision")
	}
}

// TestPostNotes_ParentNotFound_400 — parent_path that does not exist
// returns 400 parent_not_found.
func TestPostNotes_ParentNotFound_400(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"no/such/folder","title":"alpha"}`)
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "parent_not_found" {
		t.Errorf("Code: got %q, want %q", got.Code, "parent_not_found")
	}
}

// TestPostNotes_TitleWithSlash_400 — illegal title returns 400
// invalid_request.
func TestPostNotes_TitleWithSlash_400(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"","title":"a/b"}`)
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "invalid_request" {
		t.Errorf("Code: got %q, want %q", got.Code, "invalid_request")
	}
}

// TestPostNotes_PathEscape_400 — parent_path attempts traversal.
func TestPostNotes_PathEscape_400(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"../escape","title":"alpha"}`)
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}

	if got.Code != "invalid_path" && got.Code != "parent_not_found" {
		t.Errorf("Code: got %q, want invalid_path or parent_not_found", got.Code)
	}
}

// TestDeleteNoteById_HappyPath_204 — create a note, delete by id, expect
// 204 + on-disk file gone + index row gone.
func TestDeleteNoteById_HappyPath_204(t *testing.T) {
	t.Parallel()
	ts, _, root, idx := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"","title":"alpha"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create failed: %d; body=%s", resp.StatusCode, body)
	}
	var created NoteSummary
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatal(err)
	}
	id := uuid.UUID(created.Id).String()

	resp, body = mustDelete(t, ts, "/api/v1/notes/"+id)
	if resp.StatusCode != 204 {
		t.Fatalf("delete: got %d, want 204; body=%s", resp.StatusCode, body)
	}
	if _, err := os.Stat(filepath.Join(root, "alpha.md")); !os.IsNotExist(err) {
		t.Errorf("file still on disk: %v", err)
	}
	if _, ok := idx.byPath["alpha.md"]; ok {
		t.Errorf("index row not removed")
	}
}

// TestDeleteNoteById_NotFound_404 — random uuid → 404 not_found.
func TestDeleteNoteById_NotFound_404(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustDelete(t, ts, "/api/v1/notes/"+uuid.New().String())
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

// TestPostNoteMove_HappyPath_200 — create, move, expect 200 with new
// NoteSummary; on-disk file moved.
func TestPostNoteMove_HappyPath_200(t *testing.T) {
	t.Parallel()
	ts, _, root, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"","title":"alpha"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create failed: %d; body=%s", resp.StatusCode, body)
	}
	var created NoteSummary
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatal(err)
	}
	id := uuid.UUID(created.Id).String()

	resp, body = mustPostJSON(t, ts, "/api/v1/notes/"+id+"/move",
		`{"new_path":"renamed.md"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got NoteSummary
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Path != "renamed.md" {
		t.Errorf("Path: got %q, want %q", got.Path, "renamed.md")
	}
	if _, err := os.Stat(filepath.Join(root, "renamed.md")); err != nil {
		t.Errorf("renamed file not on disk: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "alpha.md")); !os.IsNotExist(err) {
		t.Errorf("old file still on disk: %v", err)
	}
}

// TestPostNoteMove_Collision_409 — moving to an occupied path returns
// 409 case_collision.
func TestPostNoteMove_Collision_409(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"","title":"alpha"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create alpha: %d; body=%s", resp.StatusCode, body)
	}
	var alpha NoteSummary
	_ = json.Unmarshal(body, &alpha)

	resp, body = mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"","title":"beta"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create beta: %d; body=%s", resp.StatusCode, body)
	}

	resp, body = mustPostJSON(t, ts, "/api/v1/notes/"+uuid.UUID(alpha.Id).String()+"/move",
		`{"new_path":"beta.md"}`)
	if resp.StatusCode != 409 {
		t.Fatalf("status: got %d, want 409; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Code != "case_collision" {
		t.Errorf("Code: got %q, want %q", got.Code, "case_collision")
	}
}

// TestPostNoteMove_NotFound_404 — move on unknown uuid → 404.
func TestPostNoteMove_NotFound_404(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes/"+uuid.New().String()+"/move",
		`{"new_path":"renamed.md"}`)
	if resp.StatusCode != 404 {
		t.Fatalf("status: got %d, want 404; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Code != "not_found" {
		t.Errorf("Code: got %q, want %q", got.Code, "not_found")
	}
}

// TestPostNoteMove_PathEscape_400 — new_path attempts traversal → 400.
func TestPostNoteMove_PathEscape_400(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"","title":"alpha"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d; body=%s", resp.StatusCode, body)
	}
	var created NoteSummary
	_ = json.Unmarshal(body, &created)

	resp, body = mustPostJSON(t, ts, "/api/v1/notes/"+uuid.UUID(created.Id).String()+"/move",
		`{"new_path":"../x.md"}`)
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}

	if got.Code != "invalid_path" && got.Code != "parent_not_found" {
		t.Errorf("Code: got %q, want invalid_path or parent_not_found", got.Code)
	}
}

// TestPostNotes_DoesNotLeakInternalErrors — when service returns a
// non-sentinel error, the wire response is a generic 500 (no leaked
// path / SQL state). We can't easily inject an arbitrary error through
// the real-FS path, so we use a fakeFileStore that returns a synthesized
// internal error for CreateFile.
func TestPostNotes_DoesNotLeakInternalErrors(t *testing.T) {
	t.Parallel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &leakyFileStore{createErr: errors.New("internal sqlite trouble: /abs/path/to/db")}
	idx := newRealIndex()
	svc := notes.NewService(files, idx, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, "")
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	ts := httptest.NewServer(r)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"","title":"alpha"}`)
	if resp.StatusCode != 500 {
		t.Fatalf("status: got %d, want 500; body=%s", resp.StatusCode, body)
	}

	if strings.Contains(string(body), "/abs/path/to/db") {
		t.Errorf("wire body leaked internal path: %s", body)
	}
}

type leakyFileStore struct {
	createErr error
}

func (l *leakyFileStore) Read(_ string) ([]byte, error)        { return nil, nil }
func (l *leakyFileStore) WriteAtomic(_ string, _ []byte) error { return nil }
func (l *leakyFileStore) Stat(_ string) (time.Time, error)     { return time.Time{}, nil }
func (l *leakyFileStore) CreateFile(_ string) error            { return l.createErr }
func (l *leakyFileStore) DeleteFile(_ string) error            { return nil }
func (l *leakyFileStore) MoveFile(_, _ string) error           { return nil }
func (l *leakyFileStore) CreateDir(_ string) error             { return nil }
func (l *leakyFileStore) DeleteDir(_ string, _ bool) error     { return nil }
func (l *leakyFileStore) MoveDir(_, _ string) error            { return nil }
func (l *leakyFileStore) TrashFile(_ string) (string, error)   { return "", nil }
func (l *leakyFileStore) TrashDir(_ string) (string, error)    { return "", nil }

type apiBroadcaster struct {
	mu     sync.Mutex
	events []apiEvent
}

type apiEvent struct {
	eventType string
	payload   any
	sessionID string
}

func (b *apiBroadcaster) Broadcast(eventType string, payload any, sessionID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, apiEvent{eventType: eventType, payload: payload, sessionID: sessionID})
}

func (b *apiBroadcaster) countByType(eventType string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, e := range b.events {
		if e.eventType == eventType {
			n++
		}
	}
	return n
}

func (b *apiBroadcaster) firstByType(eventType string) (apiEvent, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, e := range b.events {
		if e.eventType == eventType {
			return e, true
		}
	}
	return apiEvent{}, false
}

func setupRealFSServerWithBroadcaster(t *testing.T) (*httptest.Server, *notes.Service, string, *realIndex, *apiBroadcaster) {
	t.Helper()
	root := t.TempDir()
	store := fsstore.NewStore(root)
	idx := newRealIndex()
	bc := &apiBroadcaster{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := notes.NewService(store, idx, bc, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, bc, logger, "")
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r), svc, root, idx, bc
}

// TestPostNoteMove_M1_TitleChangeTriggerRewrite — happy path: title changes,
// referrer B's on-disk body gets [[OldTitle]] rewritten to [[NewTitle]];
// broadcaster receives EventLinksRewritten with B's UUID.
//
// To force a title change on move, note A is written WITHOUT an H1 heading
// so ExtractTitle falls back to the filename. Moving from foo.md → bar.md
// causes oldTitle "foo" ≠ newTitle "bar" and triggers the rewrite.
func TestPostNoteMove_M1_TitleChangeTriggerRewrite(t *testing.T) {
	t.Parallel()
	ts, _, root, idx, bc := setupRealFSServerWithBroadcaster(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes", `{"parent_path":"","title":"foo"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create A: %d; body=%s", resp.StatusCode, body)
	}
	var aSummary NoteSummary
	if err := json.Unmarshal(body, &aSummary); err != nil {
		t.Fatalf("unmarshal A: %v; body=%s", err, body)
	}
	aID := uuid.UUID(aSummary.Id)

	aPath := filepath.Join(root, "foo.md")
	if err := os.WriteFile(aPath, []byte("---\ntags: []\n---\n\nno heading here\n"), 0o600); err != nil {
		t.Fatalf("write A: %v", err)
	}

	resp, body = mustPostJSON(t, ts, "/api/v1/notes", `{"parent_path":"","title":"b"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create B: %d; body=%s", resp.StatusCode, body)
	}
	var bSummary NoteSummary
	if err := json.Unmarshal(body, &bSummary); err != nil {
		t.Fatalf("unmarshal B: %v; body=%s", err, body)
	}
	bID := uuid.UUID(bSummary.Id)
	bPath := filepath.Join(root, "b.md")

	if err := os.WriteFile(bPath, []byte("---\ntags: []\n---\n\nsee [[foo]]\n"), 0o600); err != nil {
		t.Fatalf("write B: %v", err)
	}

	bRec := idx.byID[bID]
	idx.setBacklink("foo", notes.NoteSummary{ID: bID, Path: bRec.Path, Title: "b"})

	resp, body = mustPostJSON(t, ts, "/api/v1/notes/"+aID.String()+"/move",
		`{"new_path":"bar.md"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("move: %d; body=%s", resp.StatusCode, body)
	}

	bContent, err := os.ReadFile(bPath)
	if err != nil {
		t.Fatalf("read B: %v", err)
	}
	if !strings.Contains(string(bContent), "[[bar]]") {
		t.Errorf("B not rewritten: body=%s", bContent)
	}
	if strings.Contains(string(bContent), "[[foo]]") {
		t.Errorf("B still has [[foo]]: body=%s", bContent)
	}

	if n := bc.countByType(notes.EventLinksRewritten); n != 1 {
		t.Errorf("EventLinksRewritten count: got %d, want 1", n)
	}
	ev, ok := bc.firstByType(notes.EventLinksRewritten)
	if !ok {
		t.Fatal("no EventLinksRewritten event")
	}
	payload, _ := ev.payload.(map[string]any)
	if payload["old_title"] != "foo" {
		t.Errorf("old_title: got %v, want foo", payload["old_title"])
	}
	if payload["new_title"] != "bar" {
		t.Errorf("new_title: got %v, want bar", payload["new_title"])
	}
	touchedIDs, _ := payload["touched_note_ids"].([]string)
	if len(touchedIDs) != 1 || touchedIDs[0] != bID.String() {
		t.Errorf("touched_note_ids: got %v, want [%s]", touchedIDs, bID.String())
	}
}

// TestPostNoteMove_M2_NoRewrite_WhenTitleUnchanged — moving a note to a
// new path without changing the filename stem (title unchanged) does NOT
// invoke RenameRewriteWikilinks and emits zero EventLinksRewritten events.
func TestPostNoteMove_M2_NoRewrite_WhenTitleUnchanged(t *testing.T) {
	t.Parallel()
	ts, _, root, idx, bc := setupRealFSServerWithBroadcaster(t)
	defer ts.Close()

	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}

	resp, body := mustPostJSON(t, ts, "/api/v1/notes", `{"parent_path":"","title":"foo"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create foo: %d; body=%s", resp.StatusCode, body)
	}
	var aSummary NoteSummary
	if err := json.Unmarshal(body, &aSummary); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	aID := uuid.UUID(aSummary.Id)

	otherID := uuid.New()
	idx.setBacklink("foo", notes.NoteSummary{ID: otherID, Path: "b.md", Title: "b"})

	resp, body = mustPostJSON(t, ts, "/api/v1/notes/"+aID.String()+"/move",
		`{"new_path":"sub/foo.md"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("move: %d; body=%s", resp.StatusCode, body)
	}

	if n := bc.countByType(notes.EventLinksRewritten); n != 0 {
		t.Errorf("EventLinksRewritten count: got %d, want 0", n)
	}
}

// TestPostNoteMove_M4_NoBroadcast_WhenNoReferrers — title changes (no-H1 note)
// but there are zero referrers; EventLinksRewritten is NOT broadcast (per
// RW2: empty touched slice → no broadcast).
func TestPostNoteMove_M4_NoBroadcast_WhenNoReferrers(t *testing.T) {
	t.Parallel()
	ts, _, root, _, bc := setupRealFSServerWithBroadcaster(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes", `{"parent_path":"","title":"solo"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d; body=%s", resp.StatusCode, body)
	}
	var created NoteSummary
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	aID := uuid.UUID(created.Id)

	soloPath := filepath.Join(root, "solo.md")
	_ = os.WriteFile(soloPath, []byte("---\ntags: []\n---\n\nno heading\n"), 0o600)

	resp, body = mustPostJSON(t, ts, "/api/v1/notes/"+aID.String()+"/move",
		`{"new_path":"renamed.md"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("move: %d; body=%s", resp.StatusCode, body)
	}

	if n := bc.countByType(notes.EventLinksRewritten); n != 0 {
		t.Errorf("EventLinksRewritten count: got %d, want 0", n)
	}
}

// TestPostNoteMove_M5_OldTitleCapturedBeforeMove — verifies that the old
// title is captured BEFORE Move() is called. If captured after, the registry
// would already have the new path and the old title would be lost.
//
// Uses no-H1 content so title = filename; this makes oldTitle and newTitle
// differ just from the path change.
func TestPostNoteMove_M5_OldTitleCapturedBeforeMove(t *testing.T) {
	t.Parallel()
	ts, _, root, idx, bc := setupRealFSServerWithBroadcaster(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes", `{"parent_path":"","title":"alpha"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create alpha: %d; body=%s", resp.StatusCode, body)
	}
	var created NoteSummary
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	aID := uuid.UUID(created.Id)

	aPath := filepath.Join(root, "alpha.md")
	_ = os.WriteFile(aPath, []byte("---\ntags: []\n---\n\nno heading\n"), 0o600)

	resp, body = mustPostJSON(t, ts, "/api/v1/notes", `{"parent_path":"","title":"b"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create B: %d; body=%s", resp.StatusCode, body)
	}
	var bSummary NoteSummary
	_ = json.Unmarshal(body, &bSummary)
	bID := uuid.UUID(bSummary.Id)
	bPath := filepath.Join(root, "b.md")
	_ = os.WriteFile(bPath, []byte("---\ntags: []\n---\n\nsee [[alpha]]\n"), 0o600)
	idx.setBacklink("alpha", notes.NoteSummary{ID: bID, Path: "b.md", Title: "b"})

	resp, body = mustPostJSON(t, ts, "/api/v1/notes/"+aID.String()+"/move",
		`{"new_path":"beta.md"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("move: %d; body=%s", resp.StatusCode, body)
	}

	ev, ok := bc.firstByType(notes.EventLinksRewritten)
	if !ok {
		t.Fatal("no EventLinksRewritten event emitted")
	}
	payload, _ := ev.payload.(map[string]any)
	if payload["old_title"] != "alpha" {
		t.Errorf("old_title: got %v, want alpha", payload["old_title"])
	}
	if payload["new_title"] != "beta" {
		t.Errorf("new_title: got %v, want beta", payload["new_title"])
	}
}

// A note that links to its own title is its own referrer, so its rename's
// wiki-link pass rewrites it — bumping mtime AFTER Move computed the response.
// The returned comparator must reflect the file as it actually stands, or the
// client's next save 409s against a rename it just performed itself.
func TestPostNoteMove_SelfLinkingNote_ReturnsPostRewriteComparator(t *testing.T) {
	t.Parallel()
	ts, _, root, idx, _ := setupRealFSServerWithBroadcaster(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/notes", `{"parent_path":"","title":"foo"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create foo: %d; body=%s", resp.StatusCode, body)
	}
	var created NoteSummary
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	id := uuid.UUID(created.Id)

	// No H1, so ExtractTitle falls back to the filename and foo.md → bar.md
	// counts as a title change. The body references the note's own title.
	fooPath := filepath.Join(root, "foo.md")
	if err := os.WriteFile(fooPath,
		[]byte("---\ntags: []\n---\n\nsee [[foo]] for context\n"), 0o600); err != nil {
		t.Fatalf("write foo: %v", err)
	}
	idx.setBacklink("foo", notes.NoteSummary{ID: id, Path: "foo.md", Title: "foo"})

	resp, body = mustPostJSON(t, ts, "/api/v1/notes/"+id.String()+"/move",
		`{"new_path":"bar.md"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("move: %d; body=%s", resp.StatusCode, body)
	}
	var moved MoveNoteResponse
	if err := json.Unmarshal(body, &moved); err != nil {
		t.Fatalf("unmarshal move: %v", err)
	}

	barPath := filepath.Join(root, "bar.md")
	onDisk, err := os.ReadFile(barPath)
	if err != nil {
		t.Fatalf("read bar: %v", err)
	}
	if !strings.Contains(string(onDisk), "[[bar]]") {
		t.Fatalf("self-link not rewritten, so this test proves nothing: %s", onDisk)
	}

	info, err := os.Stat(barPath)
	if err != nil {
		t.Fatalf("stat bar: %v", err)
	}
	if want := notes.ETag(info.ModTime()); moved.Etag != want {
		t.Errorf("etag = %q, want %q (the file's mtime after its own rewrite)", moved.Etag, want)
	}
}
