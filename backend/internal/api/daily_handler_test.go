package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/vault"
	"github.com/matthewoden/jasper/backend/migrations"
)

// TestDailyNotesHandler exercises GET /api/v1/daily-notes/{date}. Covers:
//   - first call: creates from template, returns 201, file exists on disk
//   - second call: returns 200 with same id
//   - invalid date formats → 400 + code='invalid_date'
//   - {{date}} template substitution in config
//   - frontmatter scaffold prepended
func TestDailyNotesHandler(t *testing.T) {
	t.Run("create branch returns 201", func(t *testing.T) {
		t.Parallel()
		srv, dataDir, _ := newDailyTestServer(t, "")

		resp, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-13"})
		if err != nil {
			t.Fatalf("GetDailyNote error: %v", err)
		}
		got201, ok := resp.(GetDailyNote201JSONResponse)
		if !ok {
			t.Fatalf("expected GetDailyNote201JSONResponse, got %T", resp)
		}
		if got201.Path != "daily/2026-05-13.md" {
			t.Errorf("path: got %q, want %q", got201.Path, "daily/2026-05-13.md")
		}

		absPath := filepath.Join(dataDir, "notes", "daily", "2026-05-13.md")
		data, err := os.ReadFile(absPath)
		if err != nil {
			t.Fatalf("written file not found: %v", err)
		}
		content := string(data)

		if !strings.HasPrefix(content, "---\ntags: []") {
			t.Errorf("missing frontmatter scaffold; content: %q", content)
		}

		if !strings.Contains(content, "2026-05-13") {
			t.Errorf("date not substituted in content; content: %q", content)
		}

		if got201.Content != content {
			t.Errorf("NoteDetail.Content differs from disk content\n  got:  %q\n  want: %q",
				got201.Content, content)
		}
	})

	t.Run("get branch returns 200 same id", func(t *testing.T) {
		t.Parallel()
		srv, dataDir, _ := newDailyTestServer(t, "")
		_ = dataDir

		resp1, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-14"})
		if err != nil {
			t.Fatalf("first call error: %v", err)
		}
		got201, ok := resp1.(GetDailyNote201JSONResponse)
		if !ok {
			t.Fatalf("first call: expected 201, got %T", resp1)
		}

		resp2, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-14"})
		if err != nil {
			t.Fatalf("second call error: %v", err)
		}
		got200, ok := resp2.(GetDailyNote200JSONResponse)
		if !ok {
			t.Fatalf("second call: expected 200, got %T", resp2)
		}
		if got200.Id != got201.Id {
			t.Errorf("id mismatch: 201 returned %s, 200 returned %s", got201.Id, got200.Id)
		}
		if got200.Path != got201.Path {
			t.Errorf("path mismatch: 201=%q, 200=%q", got201.Path, got200.Path)
		}
	})

	t.Run("invalid date returns 400", func(t *testing.T) {
		t.Parallel()
		srv, _, _ := newDailyTestServer(t, "")

		badDates := []string{
			"foo",
			"2026-5-13",
			"2026-05-13T00:00:00Z",
			"2026/05/13",
			"",
			"2026-05-1",
		}
		for _, bad := range badDates {
			resp, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: bad})
			if err != nil {
				t.Errorf("date=%q: unexpected error: %v", bad, err)
				continue
			}
			got400, ok := resp.(GetDailyNote400JSONResponse)
			if !ok {
				t.Errorf("date=%q: expected GetDailyNote400JSONResponse, got %T", bad, resp)
				continue
			}
			if got400.Code != "invalid_date" {
				t.Errorf("date=%q: code: got %q, want %q", bad, got400.Code, "invalid_date")
			}
		}
	})

	t.Run("template substitution honors config", func(t *testing.T) {
		t.Parallel()
		customTemplate := "# Daily {{date}}\n\n## Tasks\n"
		srv, dataDir, _ := newDailyTestServer(t, customTemplate)

		resp, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-15"})
		if err != nil {
			t.Fatalf("error: %v", err)
		}
		if _, ok := resp.(GetDailyNote201JSONResponse); !ok {
			t.Fatalf("expected 201, got %T", resp)
		}

		absPath := filepath.Join(dataDir, "notes", "daily", "2026-05-15.md")
		data, err := os.ReadFile(absPath)
		if err != nil {
			t.Fatalf("written file not found: %v", err)
		}
		content := string(data)

		if !strings.Contains(content, "# Daily 2026-05-15") {
			t.Errorf("expected '# Daily 2026-05-15' in content; got: %q", content)
		}
		if !strings.Contains(content, "## Tasks") {
			t.Errorf("expected '## Tasks' in content; got: %q", content)
		}
		if strings.Contains(content, "{{date}}") {
			t.Errorf("{{date}} not substituted; content: %q", content)
		}
	})

	t.Run("daily directory created idempotently", func(t *testing.T) {
		t.Parallel()
		srv, dataDir, _ := newDailyTestServer(t, "")

		dailyDir := filepath.Join(dataDir, "notes", "daily")
		if _, err := os.Stat(dailyDir); !os.IsNotExist(err) {
			_ = os.RemoveAll(dailyDir)
		}

		_, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-16"})
		if err != nil {
			t.Fatalf("error on first call: %v", err)
		}
		if _, err := os.Stat(dailyDir); err != nil {
			t.Errorf("daily/ directory not created: %v", err)
		}

		_, err = srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-17"})
		if err != nil {
			t.Fatalf("error on second call (idempotent mkdir): %v", err)
		}
	})
}

// TestDailyNotesHandler_HTTP exercises the handler via HTTP (verifies routing
// and wire format: 201/200 JSON body, 400 for bad date).
func TestDailyNotesHandler_HTTP(t *testing.T) {
	t.Parallel()
	_, ts, _ := newDailyHTTPServer(t, "")
	defer ts.Close()

	t.Run("bad date → 400", func(t *testing.T) {
		resp, err := http.Get(ts.URL + "/api/v1/daily-notes/not-a-date")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
		}
		var got Error
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("unmarshal: %v; body=%s", err, body)
		}
		if got.Code != "invalid_date" {
			t.Errorf("code: got %q, want %q", got.Code, "invalid_date")
		}
	})

	t.Run("valid date → 201 on first call", func(t *testing.T) {
		resp, err := http.Get(ts.URL + "/api/v1/daily-notes/2026-05-20")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != 201 {
			t.Fatalf("status: got %d, want 201; body=%s", resp.StatusCode, body)
		}
		var got NoteDetail
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("unmarshal: %v; body=%s", err, body)
		}
		if got.Path != "daily/2026-05-20.md" {
			t.Errorf("path: got %q, want %q", got.Path, "daily/2026-05-20.md")
		}
	})
}

type fakeIndexForDaily struct {
	byPath map[string]notes.NoteRecord
}

func newFakeIndexForDaily() *fakeIndexForDaily {
	return &fakeIndexForDaily{byPath: make(map[string]notes.NoteRecord)}
}

func (f *fakeIndexForDaily) LookupByPath(_ context.Context, path string) (notes.NoteRecord, error) {
	rec, ok := f.byPath[path]
	if !ok {
		return notes.NoteRecord{}, notes.ErrNotFound
	}
	return rec, nil
}

func (f *fakeIndexForDaily) Upsert(_ context.Context, rec notes.NoteRecord) error {
	f.byPath[rec.Path] = rec
	return nil
}

func (f *fakeIndexForDaily) Delete(_ context.Context, id uuid.UUID) error {
	for k, v := range f.byPath {
		if v.ID == id {
			delete(f.byPath, k)
			return nil
		}
	}
	return nil
}

func (f *fakeIndexForDaily) List(_ context.Context) ([]notes.NoteSummary, error) {
	return nil, nil
}

func (f *fakeIndexForDaily) MovePathPrefix(_ context.Context, _, _ string) (int, error) {
	return 0, nil
}

func (f *fakeIndexForDaily) DeleteByPathPrefix(_ context.Context, _ string) (int, error) {
	return 0, nil
}

func (f *fakeIndexForDaily) ListTags(_ context.Context) ([]notes.TagWithCount, error) {
	return nil, nil
}

func (f *fakeIndexForDaily) SyncTags(_ context.Context, _ uuid.UUID, _ []string) error {
	return nil
}

func (f *fakeIndexForDaily) SyncBacklinks(_ context.Context, _ uuid.UUID, _ string, _ []markdown.WikiLinkRef, _ *notes.Registry, _ []byte) error {
	return nil
}

func (f *fakeIndexForDaily) NotesByTag(_ context.Context, _ string) ([]notes.NoteSummary, error) {
	return nil, nil
}

func (f *fakeIndexForDaily) RenameTag(_ context.Context, _, _ string) ([]uuid.UUID, error) {
	return nil, nil
}

func (f *fakeIndexForDaily) DeleteTag(_ context.Context, _ string) ([]uuid.UUID, error) {
	return nil, nil
}

func (f *fakeIndexForDaily) SourcesByBacklinkTitle(_ context.Context, _ string) ([]notes.NoteSummary, error) {
	return nil, nil
}

func (f *fakeIndexForDaily) UpdateBacklinksTargetTitle(_ context.Context, _, _ string, _ *uuid.UUID) error {
	return nil
}

func (f *fakeIndexForDaily) GetBacklinks(_ context.Context, _ uuid.UUID) ([]notes.BacklinkRow, error) {
	return nil, nil
}

func (f *fakeIndexForDaily) SearchTitles(_ context.Context, _ string, _ int) ([]notes.SearchResult, error) {
	return nil, nil
}

func (f *fakeIndexForDaily) SearchFTS(_ context.Context, _ string, _ []string, _ int, _ string) ([]notes.SearchHit, error) {
	return nil, nil
}

// newDailyTestServer wires notes.Service to a REAL fsstore.Store (not the
// in-memory fakeFileStore) so writes actually land on disk — required now
// that GetDailyNote routes entirely through notes.Service.GetOrCreateDailyNote
// instead of writing via fsstore.AtomicWrite directly in the handler. The
// index remains the in-memory fakeIndexForDaily (returned so tests can seed
// records directly into the SAME instance the Service uses).
func newDailyTestServer(t *testing.T, dailyNotesTemplate string) (*Server, string, *fakeIndexForDaily) {
	t.Helper()
	dir := t.TempDir()

	notesDir := filepath.Join(dir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatal(err)
	}

	jasperDir := filepath.Join(dir, vault.SubdirName)
	if err := os.MkdirAll(jasperDir, 0o755); err != nil {
		t.Fatal(err)
	}

	if dailyNotesTemplate != "" {
		cfgJSON := `{"appName":"Jasper","theme":"dark","dailyNotes":{"template":"` +
			strings.ReplaceAll(dailyNotesTemplate, "\n", `\n`) +
			`"},"editor":{"fontSize":15,"lineHeight":1.6}}`
		if err := os.WriteFile(vault.ConfigPath(dir), []byte(cfgJSON), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idx := newFakeIndexForDaily()
	store := fsstore.NewStore(notesDir)
	svc := notes.NewService(store, idx, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, dir)
	return srv, dir, idx
}

func newDailyHTTPServer(t *testing.T, dailyNotesTemplate string) (*Server, *httptest.Server, string) {
	t.Helper()
	srv, dir, _ := newDailyTestServer(t, dailyNotesTemplate)
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	ts := httptest.NewServer(r)
	t.Cleanup(ts.Close)
	return srv, ts, dir
}

// TestDailyNotesHandler_RegistryHydration verifies that GetDailyNote registers
// the note's UUID into notes.Service.Registry() so that subsequent
// Service.Get(id) calls resolve immediately without a 404.
func TestDailyNotesHandler_RegistryHydration(t *testing.T) {
	t.Run("create branch registers UUID in notes.Service.Registry", func(t *testing.T) {
		t.Parallel()
		srv, _, _ := newDailyTestServer(t, "")

		resp, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-13"})
		if err != nil {
			t.Fatalf("GetDailyNote error: %v", err)
		}
		got201, ok := resp.(GetDailyNote201JSONResponse)
		if !ok {
			t.Fatalf("expected GetDailyNote201JSONResponse, got %T", resp)
		}

		id := uuid.UUID(got201.Id)

		relPath, ok := srv.notes.Registry().Lookup(id)
		if !ok {
			t.Errorf("Registry().Lookup(%s) returned ok=false; want relPath=%q, ok=true\n"+
				"(UAT #1 root cause: daily.go create branch does not call Registry().Add after Upsert)",
				id, "daily/2026-05-13.md")
		}
		if ok && relPath != "daily/2026-05-13.md" {
			t.Errorf("Registry().Lookup(%s) relPath=%q, want %q", id, relPath, "daily/2026-05-13.md")
		}
	})

	t.Run("get-existing branch registers UUID in notes.Service.Registry", func(t *testing.T) {
		t.Parallel()
		srv, _, _ := newDailyTestServer(t, "")

		resp1, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-22"})
		if err != nil {
			t.Fatalf("first GetDailyNote error: %v", err)
		}
		got201, ok := resp1.(GetDailyNote201JSONResponse)
		if !ok {
			t.Fatalf("first call: expected 201, got %T", resp1)
		}
		id := uuid.UUID(got201.Id)

		srv.notes.Registry().Remove(id)

		if _, stillOk := srv.notes.Registry().Lookup(id); stillOk {
			t.Fatal("test setup: Registry.Remove did not remove the entry — precondition failed")
		}

		resp2, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-22"})
		if err != nil {
			t.Fatalf("second GetDailyNote error: %v", err)
		}
		if _, ok := resp2.(GetDailyNote200JSONResponse); !ok {
			t.Fatalf("second call: expected 200, got %T", resp2)
		}

		relPath, ok := srv.notes.Registry().Lookup(id)
		if !ok {
			t.Errorf("Registry().Lookup(%s) returned ok=false after 200 response; want relPath=%q, ok=true\n"+
				"(UAT #6 root cause: daily.go 200 branch does not call Registry().Add)",
				id, "daily/2026-05-22.md")
		}
		if ok && relPath != "daily/2026-05-22.md" {
			t.Errorf("Registry().Lookup(%s) relPath=%q, want %q", id, relPath, "daily/2026-05-22.md")
		}
	})
}

// TestDailyNotesHandler_TagPassthrough verifies that the GetDailyNote 200
// path returns the actual frontmatter tags, not an empty slice.
func TestDailyNotesHandler_TagPassthrough(t *testing.T) {
	t.Run("get-existing branch returns frontmatter tags", func(t *testing.T) {
		t.Parallel()
		srv, dir, idx := newDailyTestServer(t, "")

		notesDir := filepath.Join(dir, "notes", "daily")
		if err := os.MkdirAll(notesDir, 0o755); err != nil {
			t.Fatalf("mkdir daily: %v", err)
		}
		content := "---\ntags: [project, jasper]\n---\n\n# 2026-04-01\n\nbody\n"
		if err := os.WriteFile(filepath.Join(notesDir, "2026-04-01.md"), []byte(content), 0o644); err != nil {
			t.Fatalf("write file: %v", err)
		}

		// Seed the record directly into the SAME index instance the Service
		// holds internally (GetOrCreateDailyNote calls s.index, not srv.index —
		// reassigning srv.index alone would not be observed by the Service).
		recID := uuid.New()
		idx.byPath["daily/2026-04-01.md"] = notes.NoteRecord{
			ID:        recID,
			Path:      "daily/2026-04-01.md",
			Title:     "2026-04-01",
			MTimeUnix: 1000000,
			SizeBytes: int64(len(content)),
		}

		ctx := context.Background()
		resp, err := srv.GetDailyNote(ctx, GetDailyNoteRequestObject{Date: "2026-04-01"})
		if err != nil {
			t.Fatalf("GetDailyNote error: %v", err)
		}

		got200, ok := resp.(GetDailyNote200JSONResponse)
		if !ok {
			t.Fatalf("expected GetDailyNote200JSONResponse, got %T", resp)
		}
		if got200.Tags == nil {
			t.Fatal("expected non-nil Tags in 200 response")
		}
		got := *got200.Tags

		want := []string{"project", "jasper"}
		if len(got) != len(want) {
			t.Fatalf("Tags: got %v (len=%d), want %v (len=%d)", got, len(got), want, len(want))
		}
		for i, w := range want {
			if got[i] != w {
				t.Errorf("Tags[%d]: got %q, want %q", i, got[i], w)
			}
		}
	})
}

var _ notes.Index = (*fakeIndexForDaily)(nil)

// newDailyRealTestServer wires notes.Service to a REAL fsstore.Store AND a
// REAL sqlite-backed index.Indexer (not the in-memory fakeIndexForDaily,
// which no-ops SearchFTS/backlink resolution) plus a recordingBroadcaster —
// mirrors newDI01TestHarness (di01_fts_body_regression_test.go). Needed for
// SY-01's FTS-searchable / [[date]]-resolvable / broadcast-contract
// assertions, none of which the in-memory fake can exercise faithfully.
func newDailyRealTestServer(t *testing.T, template string) (*Server, *index.Indexer, *recordingBroadcaster) {
	t.Helper()
	dataDir := t.TempDir()
	notesDir := filepath.Join(dataDir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}
	jasperDir := filepath.Join(dataDir, vault.SubdirName)
	if err := os.MkdirAll(jasperDir, 0o755); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
	if template != "" {
		cfgJSON := `{"appName":"Jasper","theme":"dark","dailyNotes":{"template":"` +
			strings.ReplaceAll(template, "\n", `\n`) +
			`"},"editor":{"fontSize":15,"lineHeight":1.6}}`
		if err := os.WriteFile(vault.ConfigPath(dataDir), []byte(cfgJSON), 0o644); err != nil {
			t.Fatalf("write config: %v", err)
		}
	}

	dbPath := vault.AppDBPath(dataDir)
	pair, err := sqlite.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = pair.Close() })
	for _, name := range []string{"001_initial.sql", "002_tags_backlinks.sql", "003_fts.sql", "006_birthtime.sql"} {
		data, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatalf("read migration %s: %v", name, err)
		}
		if _, err := pair.Writer.ExecContext(context.Background(), string(data)); err != nil {
			t.Fatalf("apply migration %s: %v", name, err)
		}
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idx := index.New(pair, notesDir, logger)
	store := fsstore.NewStore(notesDir)
	bc := &recordingBroadcaster{}
	svc := notes.NewService(store, idx, bc, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, bc, logger, dataDir)
	return srv, idx, bc
}

// TestGetDailyNote_BroadcastContract is the failing-first regression for
// SY-01: the create branch must broadcast note:created exactly once; the
// get branch (existing daily note) must broadcast nothing at all.
func TestGetDailyNote_BroadcastContract(t *testing.T) {
	t.Parallel()
	srv, _, bc := newDailyRealTestServer(t, "")

	resp1, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-06-01"})
	if err != nil {
		t.Fatalf("create call error: %v", err)
	}
	if _, ok := resp1.(GetDailyNote201JSONResponse); !ok {
		t.Fatalf("create call: expected 201, got %T", resp1)
	}
	if got := bc.countByType(notes.EventNoteCreated); got != 1 {
		t.Errorf("note:created count after create: got %d, want 1", got)
	}

	resp2, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-06-01"})
	if err != nil {
		t.Fatalf("get call error: %v", err)
	}
	if _, ok := resp2.(GetDailyNote200JSONResponse); !ok {
		t.Fatalf("get call: expected 200, got %T", resp2)
	}
	if got := bc.countByType(notes.EventNoteCreated); got != 1 {
		t.Errorf("note:created count after get: got %d, want still 1 (no re-broadcast on get)", got)
	}
}

// TestGetDailyNote_FTSSearchableWithoutReconcile verifies a freshly-created
// daily note's body is immediately FTS-searchable — no Reconcile call in
// between (mirrors DI-01). The default template's body is just the date
// itself, so a custom template supplies a distinct nonsense body term.
func TestGetDailyNote_FTSSearchableWithoutReconcile(t *testing.T) {
	t.Parallel()
	template := "# {{date}}\n\nzqxdailytoken distinct body\n"
	srv, idx, _ := newDailyRealTestServer(t, template)

	resp, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-06-02"})
	if err != nil {
		t.Fatalf("GetDailyNote error: %v", err)
	}
	got201, ok := resp.(GetDailyNote201JSONResponse)
	if !ok {
		t.Fatalf("expected 201, got %T", resp)
	}

	hits, err := idx.SearchFTS(context.Background(), "zqxdailytoken", nil, 10, "relevance")
	if err != nil {
		t.Fatalf("SearchFTS: %v", err)
	}
	found := false
	for _, h := range hits {
		if h.ID == got201.Id.String() {
			found = true
		}
	}
	if !found {
		t.Errorf("SearchFTS(%q): daily note %s not found; hits=%+v", "zqxdailytoken", got201.Id, hits)
	}
}

// TestGetDailyNote_ResolvableByWikilinkTitle verifies a freshly-created
// daily note's title (the date) is resolvable via the registry's byTitle
// index, so [[YYYY-MM-DD]] resolves without a reconcile.
func TestGetDailyNote_ResolvableByWikilinkTitle(t *testing.T) {
	t.Parallel()
	srv, _, _ := newDailyRealTestServer(t, "")

	resp, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-06-03"})
	if err != nil {
		t.Fatalf("GetDailyNote error: %v", err)
	}
	got201, ok := resp.(GetDailyNote201JSONResponse)
	if !ok {
		t.Fatalf("expected 201, got %T", resp)
	}

	matches := srv.notes.Registry().FindByTitle("2026-06-03", "")
	found := false
	for _, m := range matches {
		if m.ID.String() == got201.Id.String() {
			found = true
		}
	}
	if !found {
		t.Errorf("Registry.FindByTitle(%q) did not resolve to %s; matches=%+v", "2026-06-03", got201.Id, matches)
	}
}
