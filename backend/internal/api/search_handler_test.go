package api

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/migrations"
)

type seedNote struct {
	Path string // relative to notesDir, e.g. "hello.md"
	Body string // full file content (may include YAML frontmatter)
}

func newSearchTestServer(t *testing.T, seeds []seedNote) *Server {
	t.Helper()

	root := t.TempDir()
	notesDir := filepath.Join(root, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}
	storageDir := filepath.Join(root, "storage")
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		t.Fatalf("mkdir storage: %v", err)
	}
	dbPath := filepath.Join(storageDir, "app.db")

	pair, err := sqlite.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = pair.Close() })

	for _, name := range []string{"001_initial.sql", "002_tags_backlinks.sql", "003_fts.sql"} {
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
	svc := notes.NewService(store, idx, nil, logger)

	for _, s := range seeds {
		full := filepath.Join(notesDir, s.Path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir for %s: %v", s.Path, err)
		}
		if err := os.WriteFile(full, []byte(s.Body), 0o644); err != nil {
			t.Fatalf("write %s: %v", s.Path, err)
		}
	}

	if _, err := idx.Reconcile(context.Background(), index.ModeFull); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	return NewServerWithIndex(svc, nil, nil, idx, nil, logger, "")
}

func TestSearchHandler(t *testing.T) {
	seeds := []seedNote{
		{
			Path: "hello.md",
			Body: "---\ntags: [project]\n---\n# Hello\n\nhello searchable world",
		},
		{
			Path: "world.md",
			Body: "# World\n\nanother world document here",
		},
		{
			Path: "notes/foo.md",
			Body: "---\ntags: [project]\n---\n# Foo\n\ncompletely different content",
		},
	}

	srv := newSearchTestServer(t, seeds)
	ctx := context.Background()

	t.Run("happy path returns results with mark excerpt", func(t *testing.T) {
		resp, err := srv.SearchNotes(ctx, SearchNotesRequestObject{
			Params: SearchNotesParams{Q: "hello"},
		})
		if err != nil {
			t.Fatalf("SearchNotes: unexpected error %v", err)
		}
		r200, ok := resp.(SearchNotes200JSONResponse)
		if !ok {
			t.Fatalf("want 200 response, got %T", resp)
		}
		if len(r200.Results) == 0 {
			t.Fatal("want at least 1 result for 'hello', got 0")
		}
		found := false
		for _, res := range r200.Results {
			if strings.Contains(res.ExcerptHtml, "<mark>") {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("no result has <mark> in ExcerptHtml; results: %+v", r200.Results)
		}
	})

	t.Run("tag filter AND combination", func(t *testing.T) {
		tag := "project"
		limit := 50
		resp, err := srv.SearchNotes(ctx, SearchNotesRequestObject{
			Params: SearchNotesParams{Q: "world", Tag: &tag, Limit: &limit},
		})
		if err != nil {
			t.Fatalf("SearchNotes: unexpected error %v", err)
		}
		r200, ok := resp.(SearchNotes200JSONResponse)
		if !ok {
			t.Fatalf("want 200 response, got %T", resp)
		}
		for _, res := range r200.Results {
			if res.Path == "world.md" {
				t.Errorf("world.md should be excluded by tag filter; results: %+v", r200.Results)
			}
		}
		found := false
		for _, res := range r200.Results {
			if res.Path == "hello.md" {
				found = true
			}
		}
		if !found {
			t.Errorf("hello.md (tag 'project' + body 'world') should appear in results; got: %+v", r200.Results)
		}
	})

	t.Run("FTS5 syntax error returns 400 with code invalid_query", func(t *testing.T) {
		resp, err := srv.SearchNotes(ctx, SearchNotesRequestObject{
			Params: SearchNotesParams{Q: "hello ("},
		})
		if err != nil {
			t.Fatalf("SearchNotes: want nil error (handler emits 400), got: %v", err)
		}
		r400, ok := resp.(SearchNotes400JSONResponse)
		if !ok {
			t.Fatalf("want SearchNotes400JSONResponse for malformed query, got %T: %+v", resp, resp)
		}
		if r400.Code != "invalid_query" {
			t.Errorf("code: got %q, want %q", r400.Code, "invalid_query")
		}
	})

	t.Run("short query returns 200 empty", func(t *testing.T) {
		resp, err := srv.SearchNotes(ctx, SearchNotesRequestObject{
			Params: SearchNotesParams{Q: "a"},
		})
		if err != nil {
			t.Fatalf("SearchNotes: unexpected error %v", err)
		}
		r200, ok := resp.(SearchNotes200JSONResponse)
		if !ok {
			t.Fatalf("want 200 response, got %T", resp)
		}
		if len(r200.Results) != 0 {
			t.Errorf("short query: want 0 results, got %d", len(r200.Results))
		}
	})

	t.Run("nil index fast path returns 200 empty", func(t *testing.T) {
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		nilSrv := NewServerWithIndex(nil, nil, nil, nil, nil, logger, "")
		resp, err := nilSrv.SearchNotes(ctx, SearchNotesRequestObject{
			Params: SearchNotesParams{Q: "hello"},
		})
		if err != nil {
			t.Fatalf("nil-index SearchNotes: unexpected error %v", err)
		}
		r200, ok := resp.(SearchNotes200JSONResponse)
		if !ok {
			t.Fatalf("want 200, got %T", resp)
		}
		if len(r200.Results) != 0 {
			t.Errorf("nil-index: want 0 results, got %d", len(r200.Results))
		}
	})
}
