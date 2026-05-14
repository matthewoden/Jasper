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

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/migrations"
)

// ----------------------------------------------------------------------
// Plan 03-04 Task 3 — Tree handler tests.
//
// GetTree calls *Indexer.BuildTree, which depends on the SQLite-backed
// indexer + the notes/ directory. The harness builds a real *Indexer
// over a tempdir-rooted SQLite DB and a real fsstore, mirroring the
// composition root in lifecycle.Run.
// ----------------------------------------------------------------------

// setupTreeServer builds a *Server with a real *index.Indexer + a real
// fsstore.Store rooted at t.TempDir(). The notes/ directory is created
// at <tempdir>/notes; the SQLite DB at <tempdir>/storage/app.db.
func setupTreeServer(t *testing.T) (*httptest.Server, *index.Indexer, string, *notes.Service) {
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

	// Apply migrations directly via the embedded init schema. The
	// indexer needs a notes table to query/insert.
	if err := applyTestMigrations(pair); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idx := index.New(pair, notesDir, logger)
	store := fsstore.NewStore(notesDir)
	svc := notes.NewService(store, idx, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, "")
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	ts := httptest.NewServer(r)
	t.Cleanup(ts.Close)
	return ts, idx, notesDir, svc
}

// applyTestMigrations applies all three embedded migration SQL files to the
// test pair. Migration 003_fts.sql (Plan 07-02/07-03) adds body_fts and
// tag_names_fts columns to notes and the notes_fts FTS5 virtual table.
// All three must be applied because Upsert now writes body_fts/tag_names_fts.
func applyTestMigrations(pair *sqlite.Pair) error {
	for _, name := range []string{"001_initial.sql", "002_tags_backlinks.sql", "003_fts.sql"} {
		data, err := migrations.FS.ReadFile(name)
		if err != nil {
			return err
		}
		if _, err := pair.Writer.ExecContext(context.Background(), string(data)); err != nil {
			return err
		}
	}
	return nil
}

// TestGetTree_EmptyVault_200 — empty notes/ → 200 with Root: [] (NOT null).
func TestGetTree_EmptyVault_200(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupTreeServer(t)

	resp, err := http.Get(ts.URL + "/api/v1/tree")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	// JSON-decode as raw map to assert root is `[]` not `null`.
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	root, ok := raw["root"]
	if !ok {
		t.Fatalf("root key missing; body=%s", body)
	}
	arr, ok := root.([]any)
	if !ok {
		t.Fatalf("root: got %T, want []any (must be `[]` not null)", root)
	}
	if len(arr) != 0 {
		t.Errorf("root len: got %d, want 0", len(arr))
	}
}

// TestGetTree_SingleNote_200 — one note at root → 200 with one note
// node containing kind, id, path, title, updated_at.
func TestGetTree_SingleNote_200(t *testing.T) {
	t.Parallel()
	ts, _, _, svc := setupTreeServer(t)

	if _, err := svc.Create(context.Background(), "", "alpha"); err != nil {
		t.Fatalf("create: %v", err)
	}

	resp, err := http.Get(ts.URL + "/api/v1/tree")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	root, _ := raw["root"].([]any)
	if len(root) != 1 {
		t.Fatalf("root len: got %d, want 1; body=%s", len(root), body)
	}
	noteObj, ok := root[0].(map[string]any)
	if !ok {
		t.Fatalf("root[0]: got %T, want object", root[0])
	}
	if noteObj["kind"] != "note" {
		t.Errorf("kind: got %v, want note", noteObj["kind"])
	}
	if noteObj["path"] != "alpha.md" {
		t.Errorf("path: got %v, want alpha.md", noteObj["path"])
	}
	if noteObj["title"] != "alpha" {
		t.Errorf("title: got %v, want alpha", noteObj["title"])
	}
	if _, ok := noteObj["id"]; !ok {
		t.Errorf("id missing")
	}
	if _, ok := noteObj["updated_at"]; !ok {
		t.Errorf("updated_at missing")
	}
}

// TestGetTree_NoteInFolder_200 — folder + nested note → folder appears
// as a TreeNode of kind "folder" containing the note as a child.
func TestGetTree_NoteInFolder_200(t *testing.T) {
	t.Parallel()
	ts, _, _, svc := setupTreeServer(t)

	if _, err := svc.CreateFolder(context.Background(), "", "projects"); err != nil {
		t.Fatalf("create folder: %v", err)
	}
	if _, err := svc.Create(context.Background(), "projects", "alpha"); err != nil {
		t.Fatalf("create note: %v", err)
	}

	resp, err := http.Get(ts.URL + "/api/v1/tree")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d; body=%s", resp.StatusCode, body)
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	root, _ := raw["root"].([]any)
	if len(root) != 1 {
		t.Fatalf("root len: got %d, want 1; body=%s", len(root), body)
	}
	folderObj, _ := root[0].(map[string]any)
	if folderObj["kind"] != "folder" {
		t.Errorf("kind: got %v, want folder", folderObj["kind"])
	}
	if folderObj["path"] != "projects" {
		t.Errorf("path: got %v, want projects", folderObj["path"])
	}
	if folderObj["name"] != "projects" {
		t.Errorf("name: got %v, want projects", folderObj["name"])
	}
	children, _ := folderObj["children"].([]any)
	if len(children) != 1 {
		t.Fatalf("children len: got %d, want 1", len(children))
	}
	noteObj, _ := children[0].(map[string]any)
	if noteObj["kind"] != "note" {
		t.Errorf("child kind: got %v, want note", noteObj["kind"])
	}
	if noteObj["path"] != "projects/alpha.md" {
		t.Errorf("child path: got %v, want projects/alpha.md", noteObj["path"])
	}
}

// TestGetTree_FoldersBeforeNotes — root-level folder + root-level note
// → folder appears first.
func TestGetTree_FoldersBeforeNotes(t *testing.T) {
	t.Parallel()
	ts, _, _, svc := setupTreeServer(t)

	if _, err := svc.CreateFolder(context.Background(), "", "z-folder"); err != nil {
		t.Fatalf("create folder: %v", err)
	}
	if _, err := svc.Create(context.Background(), "", "a-note"); err != nil {
		t.Fatalf("create note: %v", err)
	}

	resp, _ := http.Get(ts.URL + "/api/v1/tree")
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	root, _ := raw["root"].([]any)
	if len(root) != 2 {
		t.Fatalf("root len: got %d, want 2; body=%s", len(root), body)
	}
	first, _ := root[0].(map[string]any)
	if first["kind"] != "folder" {
		t.Errorf("first kind: got %v, want folder (folders before notes)", first["kind"])
	}
}

// TestGetTree_NilIndex_ReturnsEmpty — Phase 1 compatibility: 2-arg
// NewServer (nil index) → GetTree returns Root: [].
func TestGetTree_NilIndex_ReturnsEmpty(t *testing.T) {
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

	resp, err := http.Get(ts.URL + "/api/v1/tree")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d, want 200; body=%s", resp.StatusCode, body)
	}
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	root, ok := raw["root"].([]any)
	if !ok {
		t.Fatalf("root not an array; body=%s", body)
	}
	if len(root) != 0 {
		t.Errorf("root len: got %d, want 0", len(root))
	}
}

// TestGetTree_DiscriminatorWireShape — every child has a kind field
// of either "folder" or "note"; folder objects have path/name/children;
// note objects have id/path/title/updated_at.
func TestGetTree_DiscriminatorWireShape(t *testing.T) {
	t.Parallel()
	ts, _, _, svc := setupTreeServer(t)

	if _, err := svc.CreateFolder(context.Background(), "", "projects"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(context.Background(), "", "scratch"); err != nil {
		t.Fatal(err)
	}

	resp, _ := http.Get(ts.URL + "/api/v1/tree")
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	root, _ := raw["root"].([]any)
	if len(root) < 2 {
		t.Fatalf("root len: %d, want >=2; body=%s", len(root), body)
	}
	for i, child := range root {
		obj, _ := child.(map[string]any)
		kind, _ := obj["kind"].(string)
		if kind != "folder" && kind != "note" {
			t.Errorf("[%d] kind: got %q, want folder|note", i, kind)
		}
		if kind == "folder" {
			for _, k := range []string{"path", "name", "children"} {
				if _, ok := obj[k]; !ok {
					t.Errorf("[%d] folder missing %q", i, k)
				}
			}
		}
		if kind == "note" {
			for _, k := range []string{"id", "path", "title", "updated_at"} {
				if _, ok := obj[k]; !ok {
					t.Errorf("[%d] note missing %q", i, k)
				}
			}
		}
	}
}

// TestGetTree_DoesNotLeakInternalFields — assert wire body does NOT
// contain checksum_sha256 / size_bytes / mtime_unix / updated_at_unix
// (T-03-04-03 / T-03-01-02 mitigation: wire shape is a strict subset
// of NoteRecord).
func TestGetTree_DoesNotLeakInternalFields(t *testing.T) {
	t.Parallel()
	ts, _, _, svc := setupTreeServer(t)

	if _, err := svc.Create(context.Background(), "", "alpha"); err != nil {
		t.Fatal(err)
	}

	resp, _ := http.Get(ts.URL + "/api/v1/tree")
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	for _, leak := range []string{
		"checksum_sha256",
		"size_bytes",
		"mtime_unix",
		"updated_at_unix",
	} {
		if strings.Contains(string(body), leak) {
			t.Errorf("wire body leaked internal field %q: %s", leak, body)
		}
	}
}
