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
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/matthewoden/jasper/backend/internal/buildinfo"
	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/mcp"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/vault"
	"github.com/matthewoden/jasper/backend/migrations"
)

// setupVaultAboutServer builds a fully-wired Server (real index + real MCP
// ACL) against a temp vault. JASPER_APP_HOME is isolated per project
// convention so tests never touch the real ~/.jasper/app.json.
func setupVaultAboutServer(t *testing.T) (*httptest.Server, *notes.Service, *mcp.ACL, string) {
	t.Helper()
	t.Setenv("JASPER_APP_HOME", t.TempDir())

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

	if err := applyVaultAboutTestMigrations(pair); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idx := index.New(pair, notesDir, logger)
	store := fsstore.NewStore(notesDir)
	svc := notes.NewService(store, idx, nil, logger)
	acl := mcp.NewACL(pair.Writer)

	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, root)
	srv.SetMcpACL(acl)
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	ts := httptest.NewServer(r)
	t.Cleanup(ts.Close)
	return ts, svc, acl, root
}

func applyVaultAboutTestMigrations(pair *sqlite.Pair) error {
	for _, name := range []string{
		"001_initial.sql", "002_tags_backlinks.sql", "003_fts.sql",
		"004_mcp_grants.sql", "006_birthtime.sql",
	} {
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

// TestGetVaultAbout_FullyWired_ReturnsCorrectCounts proves noteCount and
// folderCount reflect a fixture vault with nested folders (proving the
// folder walk recurses, not just top-level).
func TestGetVaultAbout_FullyWired_ReturnsCorrectCounts(t *testing.T) {
	// Not t.Parallel(): setupVaultAboutServer uses t.Setenv (JASPER_APP_HOME
	// isolation), which the testing package forbids combining with Parallel.
	ts, svc, _, root := setupVaultAboutServer(t)

	ctx := context.Background()
	if _, err := svc.CreateFolder(ctx, "", "projects"); err != nil {
		t.Fatalf("create folder projects: %v", err)
	}
	if _, err := svc.CreateFolder(ctx, "projects", "nested"); err != nil {
		t.Fatalf("create folder projects/nested: %v", err)
	}
	if _, err := svc.Create(ctx, "", "root-note"); err != nil {
		t.Fatalf("create root note: %v", err)
	}
	if _, err := svc.Create(ctx, "projects/nested", "deep-note"); err != nil {
		t.Fatalf("create nested note: %v", err)
	}

	resp, err := http.Get(ts.URL + "/api/v1/vault/about")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}

	var got VaultAbout
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}

	if got.NoteCount != 2 {
		t.Errorf("NoteCount: got %d, want 2", got.NoteCount)
	}
	if got.FolderCount != 2 {
		t.Errorf("FolderCount: got %d, want 2 (proves recursive walk, not top-level only)", got.FolderCount)
	}
	if got.VaultName != filepath.Base(root) {
		t.Errorf("VaultName: got %q, want %q", got.VaultName, filepath.Base(root))
	}
	if got.Path != root {
		t.Errorf("Path: got %q, want %q", got.Path, root)
	}
	if got.AppVersion != buildinfo.Version {
		t.Errorf("AppVersion: got %q, want %q", got.AppVersion, buildinfo.Version)
	}
	if got.McpGrantCount != 0 {
		t.Errorf("McpGrantCount: got %d, want 0 (no grants seeded)", got.McpGrantCount)
	}
	if got.McpPort == 0 {
		t.Errorf("McpPort: got 0, want a non-zero default/configured port")
	}
}

// TestGetVaultAbout_WithMcpGrant_ReflectsGrantCount asserts mcpGrantCount
// tracks the ACL's List, not just a static zero. Seeds the grant directly
// via the ACL (same *sql.DB the server uses) rather than through HTTP, to
// stay independent of the /mcp/grants wire shape.
func TestGetVaultAbout_WithMcpGrant_ReflectsGrantCount(t *testing.T) {
	// Not t.Parallel(): see TestGetVaultAbout_FullyWired_ReturnsCorrectCounts.
	ts, _, acl, _ := setupVaultAboutServer(t)

	ctx := context.Background()
	if _, err := acl.Set(ctx, "shared", mcp.TierEditOnly, "test"); err != nil {
		t.Fatalf("acl.Set: %v", err)
	}

	resp, err := http.Get(ts.URL + "/api/v1/vault/about")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var got VaultAbout
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.McpGrantCount != 1 {
		t.Errorf("McpGrantCount: got %d, want 1", got.McpGrantCount)
	}
}

// TestGetVaultAbout_NilSubsystems_Returns200WithZeros proves the handler
// never 500s when index/mcpACL are nil — degraded zeros, not an error.
func TestGetVaultAbout_NilSubsystems_Returns200WithZeros(t *testing.T) {
	// Not t.Parallel(): uses t.Setenv (see FullyWired test above).
	t.Setenv("JASPER_APP_HOME", t.TempDir())
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

	resp, err := http.Get(ts.URL + "/api/v1/vault/about")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}

	var got VaultAbout
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.NoteCount != 0 {
		t.Errorf("NoteCount: got %d, want 0", got.NoteCount)
	}
	if got.FolderCount != 0 {
		t.Errorf("FolderCount: got %d, want 0", got.FolderCount)
	}
	if got.McpGrantCount != 0 {
		t.Errorf("McpGrantCount: got %d, want 0", got.McpGrantCount)
	}
	if got.AppVersion != buildinfo.Version {
		t.Errorf("AppVersion: got %q, want %q", got.AppVersion, buildinfo.Version)
	}
}
