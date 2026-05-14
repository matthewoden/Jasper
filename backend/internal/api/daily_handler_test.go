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

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// TestDailyNotesHandler exercises GET /api/v1/daily-notes/{date}.
// Plan 07-05. Covers:
//   - first call: creates from template, returns 201, file exists on disk
//   - second call: returns 200 with same id
//   - invalid date formats → 400 + code='invalid_date'
//   - {{date}} template substitution in config
//   - frontmatter scaffold prepended (D-43)
func TestDailyNotesHandler(t *testing.T) {
	t.Run("create branch returns 201", func(t *testing.T) {
		t.Parallel()
		srv, dataDir := newDailyTestServer(t, "")

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

		// File must exist on disk.
		absPath := filepath.Join(dataDir, "notes", "daily", "2026-05-13.md")
		data, err := os.ReadFile(absPath)
		if err != nil {
			t.Fatalf("written file not found: %v", err)
		}
		content := string(data)

		// Frontmatter scaffold (D-43).
		if !strings.HasPrefix(content, "---\ntags: []") {
			t.Errorf("missing frontmatter scaffold; content: %q", content)
		}
		// Default template substitution: date appears in content.
		if !strings.Contains(content, "2026-05-13") {
			t.Errorf("date not substituted in content; content: %q", content)
		}
		// NoteDetail.Content matches disk.
		if got201.Content != content {
			t.Errorf("NoteDetail.Content differs from disk content\n  got:  %q\n  want: %q",
				got201.Content, content)
		}
	})

	t.Run("get branch returns 200 same id", func(t *testing.T) {
		t.Parallel()
		srv, dataDir := newDailyTestServer(t, "")
		_ = dataDir

		// First call — create (201).
		resp1, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-14"})
		if err != nil {
			t.Fatalf("first call error: %v", err)
		}
		got201, ok := resp1.(GetDailyNote201JSONResponse)
		if !ok {
			t.Fatalf("first call: expected 201, got %T", resp1)
		}

		// Second call — get (200), must return same id.
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
		srv, _ := newDailyTestServer(t, "")

		badDates := []string{
			"foo",
			"2026-5-13",            // month not zero-padded
			"2026-05-13T00:00:00Z", // ISO 8601 datetime (extra chars after date)
			"2026/05/13",           // wrong delimiter
			"",                     // empty
			"2026-05-1",            // day not zero-padded
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
		srv, dataDir := newDailyTestServer(t, customTemplate)

		resp, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-15"})
		if err != nil {
			t.Fatalf("error: %v", err)
		}
		if _, ok := resp.(GetDailyNote201JSONResponse); !ok {
			t.Fatalf("expected 201, got %T", resp)
		}

		// Read file from disk and verify substitution.
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
		srv, dataDir := newDailyTestServer(t, "")

		// Verify daily/ does not exist yet.
		dailyDir := filepath.Join(dataDir, "notes", "daily")
		if _, err := os.Stat(dailyDir); !os.IsNotExist(err) {
			// Some test setup may pre-create it; pre-remove for a clean slate.
			_ = os.RemoveAll(dailyDir)
		}

		// First call must create the daily/ directory.
		_, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-16"})
		if err != nil {
			t.Fatalf("error on first call: %v", err)
		}
		if _, err := os.Stat(dailyDir); err != nil {
			t.Errorf("daily/ directory not created: %v", err)
		}

		// Second call must not error even though daily/ already exists.
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

// ---- test helpers ----

// fakeIndexForDaily is a minimal notes.Index implementation that stores
// NoteRecords by path — sufficient for the get-or-create round-trip test.
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

// Plan 07-04: SearchFTS no-op stub.
func (f *fakeIndexForDaily) SearchFTS(_ context.Context, _ string, _ string, _ int) ([]notes.SearchHit, error) {
	return nil, nil
}

// newDailyTestServer creates a Server with a real temp dataDir and a fake in-memory
// index. The dailyNotesTemplate is written into config.json if non-empty; otherwise
// config.json is absent (so DefaultConfig applies).
func newDailyTestServer(t *testing.T, dailyNotesTemplate string) (*Server, string) {
	t.Helper()
	dir := t.TempDir()

	// Create <dataDir>/notes/daily structure.
	notesDir := filepath.Join(dir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Create <dataDir>/storage for config.json.
	storageDir := filepath.Join(dir, "storage")
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// If a custom template is provided, write it to config.json.
	if dailyNotesTemplate != "" {
		cfgJSON := `{"appName":"Jasper","theme":"dark","dailyNotes":{"folder":"daily","template":"` +
			strings.ReplaceAll(dailyNotesTemplate, "\n", `\n`) +
			`"},"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false}}`
		if err := os.WriteFile(filepath.Join(storageDir, "config.json"), []byte(cfgJSON), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idx := newFakeIndexForDaily()
	svc := notes.NewService(&fakeFileStore{}, idx, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, dir)
	return srv, dir
}

// newDailyHTTPServer mounts the server on an httptest.Server for HTTP-level tests.
func newDailyHTTPServer(t *testing.T, dailyNotesTemplate string) (*Server, *httptest.Server, string) {
	t.Helper()
	srv, dir := newDailyTestServer(t, dailyNotesTemplate)
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	ts := httptest.NewServer(r)
	t.Cleanup(ts.Close)
	return srv, ts, dir
}

// TestDailyNotesHandler_RegistryHydration verifies UAT #1 + #6 fixes:
// GetDailyNote must register the note's UUID into notes.Service.Registry()
// so that subsequent Service.Get(id) calls (e.g. from EditorPane.getNote)
// resolve immediately without a 404.
func TestDailyNotesHandler_RegistryHydration(t *testing.T) {
	t.Run("create branch registers UUID in notes.Service.Registry", func(t *testing.T) {
		t.Parallel()
		srv, _ := newDailyTestServer(t, "")

		resp, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-13"})
		if err != nil {
			t.Fatalf("GetDailyNote error: %v", err)
		}
		got201, ok := resp.(GetDailyNote201JSONResponse)
		if !ok {
			t.Fatalf("expected GetDailyNote201JSONResponse, got %T", resp)
		}

		// Convert openapi_types.UUID → uuid.UUID for registry lookup.
		id := uuid.UUID(got201.Id)

		// UAT #1 fix: the registry MUST know about this UUID immediately after
		// GetDailyNote returns 201. Without the fix, Lookup returns ok=false and
		// Service.Get returns ErrNotFound → EditorPane shows "Could not load note".
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
		srv, _ := newDailyTestServer(t, "")

		// First call: creates the note (201), seeds index + registry normally.
		resp1, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-22"})
		if err != nil {
			t.Fatalf("first GetDailyNote error: %v", err)
		}
		got201, ok := resp1.(GetDailyNote201JSONResponse)
		if !ok {
			t.Fatalf("first call: expected 201, got %T", resp1)
		}
		id := uuid.UUID(got201.Id)

		// Simulate post-restart stale registry: delete the id→relPath mapping.
		// This mirrors the UAT #6 scenario where admin/reindex was run but the
		// daily note was added AFTER the last full reconcile, so the registry
		// is empty for this UUID until the server is rebuilt.
		srv.notes.Registry().Remove(id)

		// Confirm the entry is gone (precondition for the test to be meaningful).
		if _, stillOk := srv.notes.Registry().Lookup(id); stillOk {
			t.Fatal("test setup: Registry.Remove did not remove the entry — precondition failed")
		}

		// Second call: the note already exists in the index (fakeIndexForDaily
		// stored it from the first call), so GetDailyNote takes the 200 branch.
		resp2, err := srv.GetDailyNote(context.Background(), GetDailyNoteRequestObject{Date: "2026-05-22"})
		if err != nil {
			t.Fatalf("second GetDailyNote error: %v", err)
		}
		if _, ok := resp2.(GetDailyNote200JSONResponse); !ok {
			t.Fatalf("second call: expected 200, got %T", resp2)
		}

		// UAT #6 fix: registry MUST be re-populated by the 200 branch.
		// Without this, the "rebuild" path leaves the registry empty until a
		// full hydrateRegistryFromIndex runs — so the first Today click after
		// rebuild shows "Could not load note".
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

// ensure fakeIndexForDaily satisfies notes.Index at compile time.
var _ notes.Index = (*fakeIndexForDaily)(nil)
