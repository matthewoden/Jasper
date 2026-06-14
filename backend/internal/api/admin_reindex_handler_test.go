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
	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/migrations"
)

func adminReindexFixture(t *testing.T, runner *migrate.Runner, idx notes.Index) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, nil, logger)
	srv := NewServerWithIndex(svc, runner, runner, idx, nil, logger, "")
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

// TestPostAdminReindex_NilRunner_503 — nil runner returns 503 "no_runner".
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
// notes_indexed reflects the on-disk count.
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

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = mustReindexPost(t, ts, `{"mode":"full"}`)
	}()
	<-rebuildDone

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

	close(rebuildBlocker)
	wg.Wait()
}

// TestPostAdminReindex_RunnerUnrecoverable_Returns503 — runner returns
// ErrUnrecoverable; handler maps to 503 with code "unrecoverable" and
// a generic wire message.
func TestPostAdminReindex_RunnerUnrecoverable_Returns503(t *testing.T) {
	t.Parallel()

	r, _, _ := newRealRunner(t)

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

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, nil, logger)
	srv := NewServerWithIndex(svc, r, r, nil, nil, logger, "")
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

func adminReindexHydrateFixture(t *testing.T) (*httptest.Server, *notes.Service, string, *index.Indexer) {
	t.Helper()
	r, pair, dir := newRealRunner(t)
	notesDir := filepath.Join(dir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idx := index.New(pair, notesDir, logger)

	r.Path2Rebuild = func(ctx context.Context) (int, error) {
		return idx.Reconcile(ctx, index.ModeFull)
	}
	store := fsstore.NewStore(notesDir)
	svc := notes.NewService(store, idx, nil, logger)
	srv := NewServerWithIndex(svc, r, r, idx, nil, logger, "")
	si := NewStrictHandler(srv, nil)
	mux := chi.NewRouter()
	mux.Route("/api/v1", func(rt chi.Router) {
		HandlerFromMux(si, rt)
	})
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, svc, notesDir, idx
}

// TestPostAdminReindex_HydratesRegistryAfterFullRebuild asserts that a UUID
// minted by the rebuild walk is reachable via the in-memory Registry (and
// therefore via GET /notes/{id}) immediately after POST /admin/reindex
// returns 202. Without post-rebuild hydration, Service.Get returns 404 on
// newly-discovered UUIDs until the server restarts.
func TestPostAdminReindex_HydratesRegistryAfterFullRebuild(t *testing.T) {
	t.Parallel()
	ts, svc, notesDir, idx := adminReindexHydrateFixture(t)

	if err := writeFixtureNotes(notesDir, map[string]string{
		"external.md": "# External\n",
	}); err != nil {
		t.Fatal(err)
	}

	resp, body := mustReindexPost(t, ts, `{"mode":"full"}`)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("POST /admin/reindex: status=%d, want 202; body=%s",
			resp.StatusCode, body)
	}

	summaries, err := idx.List(context.Background())
	if err != nil {
		t.Fatalf("indexer.List: %v", err)
	}
	if len(summaries) == 0 {
		t.Fatalf("post-rebuild: indexer.List returned no rows — fixture broken")
	}
	var externalSummary *notes.NoteSummary
	for i := range summaries {
		s := &summaries[i]
		if s.Path == "external.md" {
			externalSummary = s
		}

		if relPath, ok := svc.Registry().Lookup(s.ID); !ok || relPath != s.Path {
			t.Errorf("Gap 6a regression: Registry does not know UUID %s after reindex; SQLite says path=%q, Registry.Lookup → (%q, %v)",
				s.ID, s.Path, relPath, ok)
		}
	}
	if externalSummary == nil {
		t.Fatalf("post-rebuild: indexer.List did not include external.md; rows=%v", summaries)
	}

	resp2, body2 := mustGetReindex(t, ts, "/api/v1/notes/"+externalSummary.ID.String())
	if resp2.StatusCode != http.StatusOK {
		t.Errorf("Gap 6a regression: GET /notes/%s: status=%d, want 200; body=%s",
			externalSummary.ID, resp2.StatusCode, body2)
	}
}

// TestPostAdminReindex_HydratesRegistryAfterIncremental asserts the same
// hydration invariant for the incremental branch. The incremental path goes
// through idx.Reconcile(ModeIncremental), which mints fresh UUIDs for any
// newly-discovered files but does not drop existing rows.
func TestPostAdminReindex_HydratesRegistryAfterIncremental(t *testing.T) {
	t.Parallel()
	ts, svc, notesDir, idx := adminReindexHydrateFixture(t)

	if err := writeFixtureNotes(notesDir, map[string]string{
		"external.md": "# External\n",
	}); err != nil {
		t.Fatal(err)
	}

	resp, body := mustReindexPost(t, ts, `{"mode":"incremental"}`)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("POST /admin/reindex incremental: status=%d, want 202; body=%s",
			resp.StatusCode, body)
	}

	summaries, err := idx.List(context.Background())
	if err != nil {
		t.Fatalf("indexer.List: %v", err)
	}
	if len(summaries) == 0 {
		t.Fatalf("post-incremental: indexer.List returned no rows — fixture broken")
	}
	sawExternal := false
	for _, s := range summaries {
		if s.Path == "external.md" {
			sawExternal = true
		}
		if relPath, ok := svc.Registry().Lookup(s.ID); !ok || relPath != s.Path {
			t.Errorf("Gap 6a regression: Registry does not know UUID %s after incremental reindex; SQLite says path=%q, Registry.Lookup → (%q, %v)",
				s.ID, s.Path, relPath, ok)
		}
	}
	if !sawExternal {
		t.Fatalf("post-incremental: indexer.List did not include external.md; rows=%v", summaries)
	}
}

// TestPostAdminReindex_DoesNotHydrateWhenRebuildFails asserts the failure
// path leaves the Registry untouched. We seed a known stale entry, force
// RebuildAndReindex into ErrUnrecoverable, and verify the seed survives.
// Hydrate must not run when the rebuild errors — the error path returns
// before the Hydrate call.
func TestPostAdminReindex_DoesNotHydrateWhenRebuildFails(t *testing.T) {
	t.Parallel()

	r, pair, dir := newRealRunner(t)
	notesDir := filepath.Join(dir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idx := index.New(pair, notesDir, logger)

	store := fsstore.NewStore(notesDir)
	failSvc := notes.NewService(store, idx, nil, logger)

	stale := uuid.New()
	failSvc.Registry().Add(stale, "stale-marker.md")

	srv := NewServerWithIndex(failSvc, r, r, idx, nil, logger, "")
	si := NewStrictHandler(srv, nil)
	mux := chi.NewRouter()
	mux.Route("/api/v1", func(rt chi.Router) {
		HandlerFromMux(si, rt)
	})
	failTS := httptest.NewServer(mux)
	defer failTS.Close()

	resp, body := mustReindexPost(t, failTS, `{"mode":"full"}`)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("POST /admin/reindex (failure path): status=%d, want 503; body=%s",
			resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "unrecoverable" {
		t.Errorf("code: got %q, want %q", got.Code, "unrecoverable")
	}

	if relPath, ok := failSvc.Registry().Lookup(stale); !ok || relPath != "stale-marker.md" {
		t.Errorf("Hydrate ran on failure path (or stale entry was lost): Lookup(%s) = (%q, %v), want (%q, true)",
			stale, relPath, ok, "stale-marker.md")
	}
}

func mustGetReindex(t *testing.T, ts *httptest.Server, path string) (*http.Response, []byte) {
	t.Helper()
	resp, err := http.Get(ts.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	respBody, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp, respBody
}

type reindexEventSpy struct {
	mu     sync.Mutex
	events []string
}

func (s *reindexEventSpy) Broadcast(event string, _ any, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
}

func (s *reindexEventSpy) snapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.events))
	copy(out, s.events)
	return out
}

func adminReindexFixtureWithBroadcaster(t *testing.T, runner *migrate.Runner, idx notes.Index, bc notes.Broadcaster) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, nil, logger)
	srv := NewServerWithIndex(svc, runner, runner, idx, bc, logger, "")
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r)
}

// TestPostAdminReindex_WR07_EmitsCompleteOnRebuildError verifies that when
// reindex:started fires, reindex:complete is always emitted afterwards —
// even on error. Without this guarantee the error path returns 503 without
// a completion event, leaving connected tabs' overlay stuck on "running".
func TestPostAdminReindex_WR07_EmitsCompleteOnRebuildError(t *testing.T) {
	t.Parallel()
	r, _, _ := newRealRunner(t)

	bc := &reindexEventSpy{}
	ts := adminReindexFixtureWithBroadcaster(t, r, nil, bc)
	defer ts.Close()
	resp, _ := mustReindexPost(t, ts, `{"mode":"full"}`)
	if resp.StatusCode != 503 {
		t.Fatalf("status: got %d, want 503", resp.StatusCode)
	}
	got := bc.snapshot()

	want := []string{"reindex:started", "reindex:complete"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("event sequence: got %v, want %v", got, want)
	}
}

// TestPostAdminReindex_WR07_InvalidModeNoStartedEvent verifies that
// invalid_mode short-circuits before reindex:started fires, so no orphan
// "started" event is emitted to tabs before the 409 rejection.
func TestPostAdminReindex_WR07_InvalidModeNoStartedEvent(t *testing.T) {
	t.Parallel()
	r, _, _ := newRealRunner(t)
	bc := &reindexEventSpy{}
	ts := adminReindexFixtureWithBroadcaster(t, r, nil, bc)
	defer ts.Close()

	bogus := ReindexRequestMode("bogus")
	srv := NewServerWithIndex(
		notes.NewService(&fakeFileStore{}, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil))),
		r, r, nil, bc,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		"",
	)
	out, err := srv.PostAdminReindex(context.Background(),
		PostAdminReindexRequestObject{Body: &PostAdminReindexJSONRequestBody{Mode: &bogus}})
	if err != nil {
		t.Fatalf("PostAdminReindex returned error: %v", err)
	}
	if _, ok := out.(PostAdminReindex409JSONResponse); !ok {
		t.Fatalf("got %T, want PostAdminReindex409JSONResponse", out)
	}
	if got := bc.snapshot(); len(got) != 0 {
		t.Errorf("invalid_mode should emit no events; got %v", got)
	}
}
