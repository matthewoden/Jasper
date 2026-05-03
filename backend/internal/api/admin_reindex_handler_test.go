package api

import (
	"bytes"
	"context"
	"encoding/json"
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

	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/migrations"
)

// adminReindexFixture builds a Server with the supplied runner + index
// and mounts it under /api/v1.
func adminReindexFixture(t *testing.T, runner *migrate.Runner, idx notes.Index) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, logger)
	srv := NewServerWithIndex(svc, runner, runner, idx, logger)
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r)
}

func mustReindexPost(t *testing.T, ts *httptest.Server, body string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/admin/reindex",
		bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	return resp, respBody
}

// newRealRunner opens a real sqlite.Pair and a runner against a tempdir
// pre-seeded with the canonical 001_initial.sql.
func newRealRunner(t *testing.T) (*migrate.Runner, *sqlite.Pair, string) {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app.db")
	pair, err := sqlite.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pair.Close() })
	r := migrate.NewRunner(migrate.RunnerOptions{
		DBPath:     dbPath,
		BackupPath: filepath.Join(dir, "app.db.backup"),
		LogsPath:   filepath.Join(dir, "logs", "jasper.log"),
		Migrations: migrations.FS,
		Pair:       pair,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if _, err := r.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	return r, pair, dir
}

// TestPostAdminReindex_NilRunner_503 — Phase 1 NewServer compatibility.
func TestPostAdminReindex_NilRunner_503(t *testing.T) {
	t.Parallel()
	ts := adminReindexFixture(t, nil, nil)
	defer ts.Close()
	resp, body := mustReindexPost(t, ts, `{"mode":"full"}`)
	if resp.StatusCode != 503 {
		t.Fatalf("status: got %d, want 503; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "no_runner" {
		t.Errorf("code: got %q, want %q", got.Code, "no_runner")
	}
}

// TestPostAdminReindex_HappyPath_FullMode_202 — runner returns 5;
// handler reports 202 with started_at + notes_indexed=5.
func TestPostAdminReindex_HappyPath_FullMode_202(t *testing.T) {
	t.Parallel()
	r, _, _ := newRealRunner(t)
	r.Path2Rebuild = func(_ context.Context) (int, error) { return 5, nil }
	ts := adminReindexFixture(t, r, nil)
	defer ts.Close()

	resp, body := mustReindexPost(t, ts, `{"mode":"full"}`)
	if resp.StatusCode != 202 {
		t.Fatalf("status: got %d, want 202; body=%s", resp.StatusCode, body)
	}
	var got ReindexResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.NotesIndexed == nil || *got.NotesIndexed != 5 {
		t.Errorf("notes_indexed: got %v, want 5", got.NotesIndexed)
	}
	if got.StartedAt.IsZero() {
		t.Errorf("started_at: zero")
	}
}

// TestPostAdminReindex_IncrementalMode_DispatchesToIndexer — pass
// mode=incremental with a real Indexer + tempdir vault; assert 202 +
// notes_indexed reflects the on-disk count. W-1 verification —
// incremental no longer 503s.
func TestPostAdminReindex_IncrementalMode_DispatchesToIndexer(t *testing.T) {
	t.Parallel()
	r, pair, dir := newRealRunner(t)
	notesDir := filepath.Join(dir, "notes")
	if err := writeFixtureNotes(notesDir, map[string]string{
		"a.md":     "# Alpha",
		"sub/b.md": "# Bravo",
	}); err != nil {
		t.Fatal(err)
	}
	idx := index.New(pair, notesDir, slog.Default())
	ts := adminReindexFixture(t, r, idx)
	defer ts.Close()

	resp, body := mustReindexPost(t, ts, `{"mode":"incremental"}`)
	if resp.StatusCode != 202 {
		t.Fatalf("status: got %d, want 202 (W-1: incremental no longer 503s); body=%s",
			resp.StatusCode, body)
	}
	var got ReindexResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.NotesIndexed == nil || *got.NotesIndexed != 2 {
		t.Errorf("notes_indexed: got %v, want 2", got.NotesIndexed)
	}
}

// TestPostAdminReindex_Concurrent_Returns409 — hold reindexBusy in a
// goroutine; second call returns 409 with code "reindex_in_progress".
func TestPostAdminReindex_Concurrent_Returns409(t *testing.T) {
	r, _, _ := newRealRunner(t)
	rebuildBlocker := make(chan struct{})
	rebuildDone := make(chan struct{})
	r.Path2Rebuild = func(_ context.Context) (int, error) {
		close(rebuildDone)
		<-rebuildBlocker
		return 0, nil
	}
	ts := adminReindexFixture(t, r, nil)
	defer ts.Close()

	// Fire the first request in a goroutine; it will block inside
	// Path2Rebuild while still holding reindexBusy.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = mustReindexPost(t, ts, `{"mode":"full"}`)
	}()
	<-rebuildDone // first call has acquired the mutex

	// Second call should observe the held mutex and return 409.
	resp, body := mustReindexPost(t, ts, `{"mode":"full"}`)
	if resp.StatusCode != 409 {
		t.Fatalf("status: got %d, want 409; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "reindex_in_progress" {
		t.Errorf("code: got %q, want %q", got.Code, "reindex_in_progress")
	}

	// Release the first request and wait for it.
	close(rebuildBlocker)
	wg.Wait()
}

// TestPostAdminReindex_RunnerUnrecoverable_Returns503 — runner returns
// ErrUnrecoverable; handler maps to 503 with code "unrecoverable" and
// a generic wire message.
func TestPostAdminReindex_RunnerUnrecoverable_Returns503(t *testing.T) {
	t.Parallel()
	// Build a runner whose RebuildAndReindex fails on Path 3 (no
	// Path2Rebuild) — produces ErrUnrecoverable end-to-end.
	r, _, _ := newRealRunner(t)
	// r.Path2Rebuild left nil → Path 3 fires inside the runner.
	ts := adminReindexFixture(t, r, nil)
	defer ts.Close()
	resp, body := mustReindexPost(t, ts, `{"mode":"full"}`)
	if resp.StatusCode != 503 {
		t.Fatalf("status: got %d, want 503; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "unrecoverable" {
		t.Errorf("code: got %q, want %q", got.Code, "unrecoverable")
	}
	// Generic wire message — must NOT leak the wrapped chain
	// (T-02-04b-02).
	if strings.Contains(got.Message, "Path2Rebuild") {
		t.Errorf("message leaked internal name: %q", got.Message)
	}
}

// TestPostAdminReindex_InvalidMode_Returns409 — mode not in the enum
// returns 409 with code "invalid_mode".
func TestPostAdminReindex_InvalidMode_Returns409(t *testing.T) {
	t.Parallel()
	r, _, _ := newRealRunner(t)
	ts := adminReindexFixture(t, r, nil)
	defer ts.Close()
	// The openapi-spec validator on the server side will reject any
	// mode value that's not in the enum BEFORE reaching our handler,
	// so this test sends a body without `mode` field — wait, actually
	// per the contract, mode is optional and defaults to "full" on
	// the server. To exercise the "invalid_mode" branch we POST with
	// the mode field omitted from the spec entirely (raw map
	// serialization).
	//
	// Since the openapi-codegen-generated middleware enforces the enum,
	// we can't send a literal `{"mode":"bogus"}` through the strict
	// handler — the request decoder will reject it as a 400 first.
	// This branch is therefore reachable only via direct method
	// invocation; we verify it via a unit-level call rather than
	// through the HTTP layer.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, logger)
	srv := NewServerWithIndex(svc, r, r, nil, logger)
	bogus := ReindexRequestMode("bogus")
	out, err := srv.PostAdminReindex(context.Background(),
		PostAdminReindexRequestObject{Body: &PostAdminReindexJSONRequestBody{Mode: &bogus}})
	if err != nil {
		t.Fatalf("unit call: %v", err)
	}
	got409, ok := out.(PostAdminReindex409JSONResponse)
	if !ok {
		t.Fatalf("got %T, want PostAdminReindex409JSONResponse", out)
	}
	if got409.Code != "invalid_mode" {
		t.Errorf("code: got %q, want %q", got409.Code, "invalid_mode")
	}
}

// TestPostAdminReindex_IncrementalMode_NoIndex_Returns503 — runner
// wired but index nil; incremental mode returns 503 "no_indexer".
func TestPostAdminReindex_IncrementalMode_NoIndex_Returns503(t *testing.T) {
	t.Parallel()
	r, _, _ := newRealRunner(t)
	ts := adminReindexFixture(t, r, nil)
	defer ts.Close()
	resp, body := mustReindexPost(t, ts, `{"mode":"incremental"}`)
	if resp.StatusCode != 503 {
		t.Fatalf("status: got %d, want 503; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Code != "no_indexer" {
		t.Errorf("code: got %q, want %q", got.Code, "no_indexer")
	}
}

// writeFixtureNotes writes a map of relpath→content under notesDir
// with a fixed mtime, creating intermediate dirs as needed.
func writeFixtureNotes(notesDir string, files map[string]string) error {
	mtime := time.Unix(1700000000, 0)
	for rel, body := range files {
		full := filepath.Join(notesDir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			return err
		}
		if err := os.Chtimes(full, mtime, mtime); err != nil {
			return err
		}
	}
	return nil
}
