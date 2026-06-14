package api

import (
	"context"
	"encoding/json"
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
	"github.com/matthewoden/jasper/backend/internal/vault"
)

// Dot-filter tests: the file tree, indexer, and search all skip the
// per-vault `.jasper/` subdirectory because the dot-prefix filter in
// index/walk.go + index/tree.go elides it. These tests pin that behavior
// so a future refactor that loosens the filter surfaces immediately.
//
// The fixture places `.jasper/` INSIDE notesDir (worst case — in production
// `.jasper/` is a sibling of notes/). If the filter regresses, sentinel.md
// appears in the tree and in the indexer's reconciled set.
//
// Tests exercise GetTree + Indexer.BuildTree directly without httptest.Server
// to keep assertions focused on the filter.

func setupDotFilterPhase9(t *testing.T) (*Server, *index.Indexer, string) {
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

	if err := applyTestMigrations(pair); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	// Worst-case: place a .jasper/ directory + sentinel.md INSIDE notes/
	// so the walker MUST hit the filter to skip it. If the filter ever
	// regresses, the sentinel would surface in the tree + index.
	nestedJasper := filepath.Join(notesDir, vault.SubdirName)
	if err := os.MkdirAll(nestedJasper, 0o755); err != nil {
		t.Fatalf("mkdir nested .jasper: %v", err)
	}
	if err := os.WriteFile(filepath.Join(nestedJasper, "sentinel.md"),
		[]byte("# do not index me\n"), 0o600); err != nil {
		t.Fatalf("write sentinel.md: %v", err)
	}

	// Add a legitimate note so the tree/indexer have at least one row.
	if err := os.WriteFile(filepath.Join(notesDir, "real-note.md"),
		[]byte("# real\n"), 0o600); err != nil {
		t.Fatalf("write real-note.md: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idx := index.New(pair, notesDir, logger)
	store := fsstore.NewStore(notesDir)
	svc := notes.NewService(store, idx, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, "")
	return srv, idx, notesDir
}

// TestPhase9_TreeSkipsDotJasper asserts the GetTree handler does NOT include
// a `.jasper/` folder or `.jasper/sentinel.md` even when the fixture places
// them inside notesDir. The dot-prefix filter in index/tree.go elides every
// path component beginning with `.`.
func TestPhase9_TreeSkipsDotJasper(t *testing.T) {
	t.Parallel()
	srv, idx, _ := setupDotFilterPhase9(t)

	if _, err := idx.ReconcileWithRegistry(context.Background(), index.ModeFull, nil); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	resp, err := srv.GetTree(context.Background(), GetTreeRequestObject{})
	if err != nil {
		t.Fatalf("GetTree: %v", err)
	}
	got, ok := resp.(GetTree200JSONResponse)
	if !ok {
		t.Fatalf("GetTree: got %T, want GetTree200JSONResponse", resp)
	}

	// Marshal to JSON and walk the wire shape — discriminator-aware
	// traversal via map[string]any side-steps the union codegen.
	body, err := json.Marshal(Tree(got))
	if err != nil {
		t.Fatalf("marshal tree: %v", err)
	}

	bodyStr := string(body)
	if strings.Contains(bodyStr, vault.SubdirName) {
		t.Errorf("tree body leaks per-vault subdir name %q: %s", vault.SubdirName, bodyStr)
	}
	if strings.Contains(bodyStr, "sentinel.md") {
		t.Errorf("tree body includes sentinel.md from inside .jasper/: %s", bodyStr)
	}
	if !strings.Contains(bodyStr, "real-note.md") {
		t.Fatalf("positive control failed: real-note.md not in tree body: %s", bodyStr)
	}

	// Structural assertion: walk the JSON tree and assert no node's
	// path starts with `.` or contains the .jasper/ segment.
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	root, ok := raw["root"].([]any)
	if !ok {
		t.Fatalf("root: got %T, want array", raw["root"])
	}

	var visit func(node any)
	visit = func(node any) {
		obj, ok := node.(map[string]any)
		if !ok {
			return
		}
		if p, _ := obj["path"].(string); p != "" {
			if strings.HasPrefix(p, ".") ||
				strings.Contains(p, "/"+vault.SubdirName+"/") ||
				strings.HasPrefix(p, vault.SubdirName+"/") {
				t.Errorf("tree node path includes dot-dir segment: %q", p)
			}
		}
		if n, _ := obj["name"].(string); strings.HasPrefix(n, ".") {
			t.Errorf("tree node name is dot-prefixed: %q", n)
		}
		if kids, ok := obj["children"].([]any); ok {
			for _, c := range kids {
				visit(c)
			}
		}
	}
	for _, n := range root {
		visit(n)
	}
}

// TestPhase9_IndexerSkipsDotJasper asserts the full reconcile does NOT
// register any `.md` file under a `.jasper/` subdirectory of notesDir.
// If the filter regressed, sentinel.md would land in the indexed set.
func TestPhase9_IndexerSkipsDotJasper(t *testing.T) {
	t.Parallel()
	srv, idx, _ := setupDotFilterPhase9(t)

	if _, err := idx.ReconcileWithRegistry(context.Background(), index.ModeFull, nil); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	// Call BuildTree directly — same surface the tree handler uses.
	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}

	// Positive control: real-note.md must appear at the tree root.
	var sawReal bool
	for _, n := range tree.Root {
		if n.Note != nil && n.Note.Path == "real-note.md" {
			sawReal = true
		}
	}
	if !sawReal {
		t.Fatalf("positive control failed: real-note.md not in indexer tree (root len=%d)", len(tree.Root))
	}

	// Negative assertion: no .jasper/ contents leak into the indexer's
	// projection.
	var visit func(node index.TreeNode)
	visit = func(node index.TreeNode) {
		if node.Folder != nil {
			if strings.HasPrefix(node.Folder.Name, ".") {
				t.Errorf("indexer registered dot-prefixed folder: %q", node.Folder.Name)
			}
			if strings.Contains(node.Folder.Path, vault.SubdirName) {
				t.Errorf("indexer registered folder with .jasper/ segment: %q", node.Folder.Path)
			}
			for _, c := range node.Folder.Children {
				visit(c)
			}
		}
		if node.Note != nil {
			if strings.Contains(node.Note.Path, vault.SubdirName) {
				t.Errorf("indexer registered note under .jasper/: %q", node.Note.Path)
			}
			if strings.Contains(node.Note.Path, "sentinel") {
				t.Errorf("indexer registered sentinel.md from .jasper/: %q", node.Note.Path)
			}
			if strings.HasPrefix(node.Note.Path, ".") {
				t.Errorf("indexer registered dot-prefixed note: %q", node.Note.Path)
			}
		}
		if node.File != nil {
			if strings.HasPrefix(node.File.Path, ".") {
				t.Errorf("indexer registered dot-prefixed file: %q", node.File.Path)
			}
			if strings.Contains(node.File.Path, vault.SubdirName) {
				t.Errorf("indexer registered file under .jasper/: %q", node.File.Path)
			}
		}
	}
	for _, n := range tree.Root {
		visit(n)
	}

	// Silence "srv declared and not used"-style review — the handler
	// shares the same Indexer + Service the test exercises above; we
	// keep the variable to anchor the comment that the server-side
	// projection used by the wire handler is the same projection
	// being verified.
	_ = srv
}
