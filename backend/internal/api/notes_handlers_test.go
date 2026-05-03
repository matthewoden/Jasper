package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// fakeIndex is a test-only notes.Index implementation.
type fakeIndex struct {
	listResult []notes.NoteSummary
	listErr    error
}

func (f *fakeIndex) Upsert(_ context.Context, _ notes.NoteRecord) error  { return nil }
func (f *fakeIndex) Delete(_ context.Context, _ uuid.UUID) error         { return nil }
func (f *fakeIndex) List(_ context.Context) ([]notes.NoteSummary, error) { return f.listResult, f.listErr }

// Phase 3 Plan 03-03 — extended notes.Index port methods. The api-package
// tests do not exercise these; default no-op implementations keep the
// port satisfied at compile time.
func (f *fakeIndex) LookupByPath(_ context.Context, _ string) (notes.NoteRecord, error) {
	return notes.NoteRecord{}, notes.ErrNotFound
}
func (f *fakeIndex) MovePathPrefix(_ context.Context, _, _ string) (int, error) { return 0, nil }
func (f *fakeIndex) DeleteByPathPrefix(_ context.Context, _ string) (int, error) {
	return 0, nil
}

// setupGetNotesServer builds a Server wired with the given index and
// mounts the strict-server bridge under /api/v1.
func setupGetNotesServer(t *testing.T, idx notes.Index) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, logger)
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
	// Decode as a map so we can verify the JSON shape (notes key is
	// `[]` not `null`).
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

// TestGetNotes_NilIndex_FallsBackToEmpty — Phase 1 NewServer
// compatibility: nil index → empty list, NOT 503.
func TestGetNotes_NilIndex_FallsBackToEmpty(t *testing.T) {
	t.Parallel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, logger)
	srv := NewServer(svc, logger) // 2-arg form — no index passed
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

// TestGetNotes_IndexErr_Returns500_GenericMessage — index.List returns
// an error; the handler maps to 500 with a generic wire message
// (T-02-04b-02 — never leak the wrapped chain).
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
	// The generic message — NOT the absolute path that the underlying
	// error contained.
	if string(body) == "" {
		t.Errorf("body empty")
	}
}
