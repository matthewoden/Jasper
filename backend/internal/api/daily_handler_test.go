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
	"github.com/matthewoden/jasper/backend/internal/vault"
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
		srv, dataDir := newDailyTestServer(t, "")
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
		srv, _ := newDailyTestServer(t, "")

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
		srv, dataDir := newDailyTestServer(t, customTemplate)

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
		srv, dataDir := newDailyTestServer(t, "")

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

func (f *fakeIndexForDaily) SearchFTS(_ context.Context, _ string, _ string, _ int) ([]notes.SearchHit, error) {
	return nil, nil
}

func newDailyTestServer(t *testing.T, dailyNotesTemplate string) (*Server, string) {
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
		cfgJSON := `{"appName":"Jasper","theme":"dark","dailyNotes":{"folder":"daily","template":"` +
			strings.ReplaceAll(dailyNotesTemplate, "\n", `\n`) +
			`"},"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false}}`
		if err := os.WriteFile(vault.ConfigPath(dir), []byte(cfgJSON), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idx := newFakeIndexForDaily()
	svc := notes.NewService(&fakeFileStore{}, idx, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, dir)
	return srv, dir
}

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

// TestDailyNotesHandler_RegistryHydration verifies that GetDailyNote registers
// the note's UUID into notes.Service.Registry() so that subsequent
// Service.Get(id) calls resolve immediately without a 404.
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
		srv, _ := newDailyTestServer(t, "")

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
		srv, dir := newDailyTestServer(t, "")

		notesDir := filepath.Join(dir, "notes", "daily")
		if err := os.MkdirAll(notesDir, 0o755); err != nil {
			t.Fatalf("mkdir daily: %v", err)
		}
		content := "---\ntags: [project, jasper]\n---\n\n# 2026-04-01\n\nbody\n"
		if err := os.WriteFile(filepath.Join(notesDir, "2026-04-01.md"), []byte(content), 0o644); err != nil {
			t.Fatalf("write file: %v", err)
		}

		recID := uuid.New()
		fakeIdx := newFakeIndexForDaily()
		fakeIdx.byPath["daily/2026-04-01.md"] = notes.NoteRecord{
			ID:        recID,
			Path:      "daily/2026-04-01.md",
			Title:     "2026-04-01",
			MTimeUnix: 1000000,
			SizeBytes: int64(len(content)),
		}
		srv.index = fakeIdx

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
