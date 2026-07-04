package api

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/vault"
	"github.com/matthewoden/jasper/backend/migrations"
)

// newDI01TestHarness mirrors newSearchTestServer (search_handler_test.go) but
// returns the raw Service + Indexer instead of a Server, so tests can drive
// Update/CreateWithBody/Move directly and assert against SearchFTS without a
// Reconcile call in between (DI-01: interactive saves must not wipe body FTS).
func newDI01TestHarness(t *testing.T) (*notes.Service, *index.Indexer) {
	t.Helper()

	root := t.TempDir()
	notesDir := filepath.Join(root, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}
	jasperDir := filepath.Join(root, vault.SubdirName)
	if err := os.MkdirAll(jasperDir, 0o755); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
	dbPath := vault.AppDBPath(root)

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

	return svc, idx
}

// TestDI01_InteractiveSavesKeepBodyFTS is the failing-first regression for
// DI-01: Update, Create, and Move must leave the note's body text
// immediately searchable via FTS — WITHOUT any Reconcile call in between.
// Every token below is a nonsense body-only word absent from the note's
// title/filename/path, so the title/path-LIKE fallback in SearchFTS cannot
// mask the bug.
func TestDI01_InteractiveSavesKeepBodyFTS(t *testing.T) {
	ctx := context.Background()

	t.Run("update", func(t *testing.T) {
		svc, idx := newDI01TestHarness(t)

		created, err := svc.CreateWithBody(ctx, "", "di01-update", "\n\ninitial body")
		if err != nil {
			t.Fatalf("CreateWithBody: %v", err)
		}

		if _, err := svc.Update(ctx, created.ID, "zqxbodyupdate distinct body", ""); err != nil {
			t.Fatalf("Update: %v", err)
		}

		hits, err := idx.SearchFTS(ctx, "zqxbodyupdate", nil, 10)
		if err != nil {
			t.Fatalf("SearchFTS: %v", err)
		}
		if len(hits) == 0 {
			t.Fatalf("SearchFTS(%q): want >=1 hit after Update with NO reconcile, got 0", "zqxbodyupdate")
		}
		found := false
		for _, h := range hits {
			if h.ID == created.ID.String() {
				found = true
			}
		}
		if !found {
			t.Errorf("SearchFTS(%q): hit found but not for the updated note %s; hits=%+v", "zqxbodyupdate", created.ID, hits)
		}
	})

	t.Run("create", func(t *testing.T) {
		svc, idx := newDI01TestHarness(t)

		created, err := svc.CreateWithBody(ctx, "", "di01-create", "\n\nzqxbodycreate here")
		if err != nil {
			t.Fatalf("CreateWithBody: %v", err)
		}

		hits, err := idx.SearchFTS(ctx, "zqxbodycreate", nil, 10)
		if err != nil {
			t.Fatalf("SearchFTS: %v", err)
		}
		if len(hits) == 0 {
			t.Fatalf("SearchFTS(%q): want >=1 hit after CreateWithBody with NO reconcile, got 0", "zqxbodycreate")
		}
		found := false
		for _, h := range hits {
			if h.ID == created.ID.String() {
				found = true
			}
		}
		if !found {
			t.Errorf("SearchFTS(%q): hit found but not for the created note %s; hits=%+v", "zqxbodycreate", created.ID, hits)
		}
	})

	t.Run("move", func(t *testing.T) {
		svc, idx := newDI01TestHarness(t)

		created, err := svc.CreateWithBody(ctx, "", "di01-move", "\n\nzqxbodymove payload")
		if err != nil {
			t.Fatalf("CreateWithBody: %v", err)
		}

		if _, err := svc.Move(ctx, created.ID, "moved-di01.md"); err != nil {
			t.Fatalf("Move: %v", err)
		}

		hits, err := idx.SearchFTS(ctx, "zqxbodymove", nil, 10)
		if err != nil {
			t.Fatalf("SearchFTS: %v", err)
		}
		if len(hits) == 0 {
			t.Fatalf("SearchFTS(%q): want >=1 hit after Move with NO reconcile, got 0", "zqxbodymove")
		}
		found := false
		for _, h := range hits {
			if h.ID == created.ID.String() {
				found = true
			}
		}
		if !found {
			t.Errorf("SearchFTS(%q): hit found but not for the moved note %s; hits=%+v", "zqxbodymove", created.ID, hits)
		}
	})
}
