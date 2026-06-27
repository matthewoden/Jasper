package mcp_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/mcp"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

type fakeNotesProvider struct {
	notes []notes.NoteSummary
}

func (f *fakeNotesProvider) List(_ context.Context) ([]notes.NoteSummary, error) {
	return f.notes, nil
}

type fakeSearchProvider struct {
	last  string
	hits  []mcp.SearchHit
	limit int
}

func (f *fakeSearchProvider) Search(_ context.Context, q string, limit int) ([]mcp.SearchHit, error) {
	f.last = q
	f.limit = limit
	return f.hits, nil
}

type fakeAttachProvider struct {
	bytes []byte
	mime  string
	err   error
}

func (f *fakeAttachProvider) Read(_ context.Context, _, _ string) ([]byte, string, error) {
	if f.err != nil {
		return nil, "", f.err
	}
	return f.bytes, f.mime, nil
}

func buildToolFixture(t *testing.T) (*notes.Service, string, *fakeNotesProvider, string) {
	t.Helper()
	root := t.TempDir()

	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir root: %v", err)
	}
	store := fsstore.NewStore(root)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := notes.NewService(store, nil, nil, logger)
	provider := &fakeNotesProvider{}

	if err := os.MkdirAll(filepath.Join(root, "projects"), 0o755); err != nil {
		t.Fatalf("mkdir projects: %v", err)
	}
	return svc, root, provider, root
}

func newTestServer(t *testing.T) *testServerFixture {
	t.Helper()
	notesSvc, root, notesProv, _ := buildToolFixture(t)
	search := &fakeSearchProvider{}
	attach := &fakeAttachProvider{}
	acl := mcp.NewACL(openTestDB(t))
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := mcp.NewServer(notesSvc, notesProv, search, attach, acl, nil, logger)
	return &testServerFixture{
		Server:    srv,
		NotesSvc:  notesSvc,
		NotesProv: notesProv,
		Search:    search,
		Attach:    attach,
		ACL:       acl,
		Root:      root,
	}
}

type testServerFixture struct {
	Server    *mcp.Server
	NotesSvc  *notes.Service
	NotesProv *fakeNotesProvider
	Search    *fakeSearchProvider
	Attach    *fakeAttachProvider
	ACL       *mcp.ACL
	Root      string
}

func (f *testServerFixture) callTool(t *testing.T, name string, args map[string]any) (*mcpsdk.CallToolResult, error) {
	t.Helper()
	ctx := context.Background()
	st, ct := mcpsdk.NewInMemoryTransports()
	ss, err := f.Server.SDK().Connect(ctx, st, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	defer func() { _ = ss.Close() }()

	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: "test", Version: "v0.0.1"}, nil)
	cs, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer func() { _ = cs.Close() }()

	return cs.CallTool(ctx, &mcpsdk.CallToolParams{
		Name:      name,
		Arguments: args,
	})
}

func TestTool_ListNotes_HappyPath(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	id := uuid.New()
	f.NotesProv.notes = []notes.NoteSummary{
		{ID: id, Path: "projects/alpha.md", Title: "Alpha", UpdatedAt: time.Now()},
	}
	res, err := f.callTool(t, "list_notes", map[string]any{})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", res.Content)
	}

	text := flattenContent(res)
	if !strings.Contains(text, id.String()) {
		t.Errorf("output missing id %s: %s", id.String(), text)
	}
	if !strings.Contains(text, "projects/alpha.md") {
		t.Errorf("output missing path: %s", text)
	}
}

func TestTool_ReadNote_ByID(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	summary, err := f.NotesSvc.Create(context.Background(), "projects", "alpha")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	res, err := f.callTool(t, "read_note", map[string]any{"id": summary.ID.String()})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", res.Content)
	}
	text := flattenContent(res)
	if !strings.Contains(text, summary.ID.String()) {
		t.Errorf("expected id %s in output: %s", summary.ID.String(), text)
	}
	if !strings.Contains(text, "projects/alpha.md") {
		t.Errorf("expected path projects/alpha.md in output: %s", text)
	}
}

func TestTool_ReadNote_ByPath(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	summary, err := f.NotesSvc.Create(context.Background(), "projects", "beta")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	f.NotesProv.notes = []notes.NoteSummary{{ID: summary.ID, Path: "projects/beta.md", Title: "beta"}}
	res, err := f.callTool(t, "read_note", map[string]any{"path": "projects/beta.md"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", res.Content)
	}
	text := flattenContent(res)
	if !strings.Contains(text, summary.ID.String()) {
		t.Errorf("expected id %s in output: %s", summary.ID.String(), text)
	}
}

func TestTool_SearchNotes_ForwardsToProvider(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	f.Search.hits = []mcp.SearchHit{
		{ID: "id-1", Path: "projects/found.md", Title: "Found", ExcerptHTML: "<mark>found</mark>"},
	}
	res, err := f.callTool(t, "search_notes", map[string]any{"query": "hello", "limit": 5})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", res.Content)
	}
	if f.Search.last != "hello" {
		t.Errorf("provider got q=%q, want %q", f.Search.last, "hello")
	}
	if f.Search.limit != 5 {
		t.Errorf("provider got limit=%d, want 5", f.Search.limit)
	}
	text := flattenContent(res)
	if !strings.Contains(text, "projects/found.md") {
		t.Errorf("expected path in output: %s", text)
	}
}

func TestTool_ReadAttachment_RoundTrip(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	notesRoot := filepath.Join(root, "notes")
	folderDir := filepath.Join(notesRoot, "projects", "myfolder")
	attachDir := filepath.Join(folderDir, "attachments")
	if err := os.MkdirAll(attachDir, 0o755); err != nil {
		t.Fatalf("mkdir attachments: %v", err)
	}

	store := fsstore.NewStore(notesRoot)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	notesSvc := notes.NewService(store, nil, nil, logger)
	summary, err := notesSvc.Create(context.Background(), "projects/myfolder", "note")
	if err != nil {
		t.Fatalf("Create note: %v", err)
	}

	pngBytes := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef}
	attachPath := filepath.Join(attachDir, "test.png")
	if err := os.WriteFile(attachPath, pngBytes, 0o600); err != nil {
		t.Fatalf("write attachment: %v", err)
	}

	adapter := mcp.NewAttachmentAdapter(notesSvc, root)
	provider := &fakeNotesProvider{}
	search := &fakeSearchProvider{}
	acl := mcp.NewACL(openTestDB(t))
	srv := mcp.NewServer(notesSvc, provider, search, adapter, acl, nil, logger)

	f := &testServerFixture{Server: srv, NotesSvc: notesSvc, NotesProv: provider, Search: search, ACL: acl, Root: root}

	res, err := f.callTool(t, "read_attachment", map[string]any{
		"note_id":  summary.ID.String(),
		"filename": "test.png",
	})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", flattenContent(res))
	}

	text := flattenContent(res)
	if !strings.Contains(text, `"mime":"image/png"`) {
		t.Errorf("expected image/png mime in output: %s", text)
	}

	wantB64 := base64.StdEncoding.EncodeToString(pngBytes)
	if !strings.Contains(text, wantB64) {
		t.Errorf("expected base64 of pngBytes in output. want=%s got=%s", wantB64, text)
	}
}

func TestTool_ReadAttachment_RejectsTraversal(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	notesRoot := filepath.Join(root, "notes")
	if err := os.MkdirAll(filepath.Join(notesRoot, "projects"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	store := fsstore.NewStore(notesRoot)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	notesSvc := notes.NewService(store, nil, nil, logger)
	summary, err := notesSvc.Create(context.Background(), "projects", "n")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	adapter := mcp.NewAttachmentAdapter(notesSvc, root)
	srv := mcp.NewServer(notesSvc, &fakeNotesProvider{}, &fakeSearchProvider{}, adapter, mcp.NewACL(openTestDB(t)), nil, logger)
	f := &testServerFixture{Server: srv}

	res, err := f.callTool(t, "read_attachment", map[string]any{
		"note_id":  summary.ID.String(),
		"filename": "../escape.png",
	})
	if err != nil {
		t.Fatalf("CallTool returned err: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected tool error for traversal filename")
	}
	text := flattenContent(res)
	if !strings.Contains(text, "path separators") && !strings.Contains(text, "'..'") {
		t.Errorf("expected path-separator/.. message in error: %s", text)
	}
}

func TestTool_CreateNote_DeniedWithoutGrant(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)

	res, err := f.callTool(t, "create_note", map[string]any{"path": "projects/x.md"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected tool error (no grant)")
	}
	if !strings.Contains(flattenContent(res), "no_grant") {
		t.Errorf("expected no_grant in error: %s", flattenContent(res))
	}
}

func TestTool_CreateNote_AllowedAtTier1(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
		t.Fatalf("Set grant: %v", err)
	}
	res, err := f.callTool(t, "create_note", map[string]any{"path": "projects/x.md"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", flattenContent(res))
	}

	if _, err := os.Stat(filepath.Join(f.Root, "projects", "x.md")); err != nil {
		t.Errorf("expected projects/x.md on disk: %v", err)
	}
}

func TestTool_UpdateNote_DeniedWithoutGrant(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)

	summary, err := f.NotesSvc.Create(context.Background(), "projects", "x")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	f.NotesProv.notes = []notes.NoteSummary{{ID: summary.ID, Path: summary.Path, Title: summary.Title}}

	res, err := f.callTool(t, "update_note", map[string]any{
		"path": summary.Path,
		"body": "new body",
	})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected tool error (no grant)")
	}
	if !strings.Contains(flattenContent(res), "no_grant") {
		t.Errorf("expected no_grant in error: %s", flattenContent(res))
	}
}

func TestTool_UpdateNote_AllowedAtTier1(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
		t.Fatalf("Set grant: %v", err)
	}
	summary, err := f.NotesSvc.Create(context.Background(), "projects", "y")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	f.NotesProv.notes = []notes.NoteSummary{{ID: summary.ID, Path: summary.Path, Title: summary.Title}}
	res, err := f.callTool(t, "update_note", map[string]any{
		"path": summary.Path,
		"body": "new body",
	})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", flattenContent(res))
	}
}

// 11. update_note with stale If-Match → conflict
func TestTool_UpdateNote_StaleIfMatch_ReturnsConflict(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
		t.Fatalf("Set grant: %v", err)
	}
	summary, err := f.NotesSvc.Create(context.Background(), "projects", "z")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	f.NotesProv.notes = []notes.NoteSummary{{ID: summary.ID, Path: summary.Path, Title: summary.Title}}

	staleTag := time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339Nano)
	res, err := f.callTool(t, "update_note", map[string]any{
		"path":     summary.Path,
		"body":     "racy",
		"if_match": staleTag,
	})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected conflict error for stale If-Match")
	}
	text := flattenContent(res)
	if !strings.Contains(text, "conflict") {
		t.Errorf("expected 'conflict' in error: %s", text)
	}
	if !strings.Contains(text, "latest_updated_at=") {
		t.Errorf("expected latest_updated_at= in error: %s", text)
	}
}

func TestTool_MoveNote_DeniedAtTier1(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
		t.Fatalf("Set grant: %v", err)
	}
	summary, err := f.NotesSvc.Create(context.Background(), "projects", "src")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	f.NotesProv.notes = []notes.NoteSummary{{ID: summary.ID, Path: summary.Path, Title: summary.Title}}
	res, err := f.callTool(t, "move_note", map[string]any{
		"path":     summary.Path,
		"new_path": "projects/dst.md",
	})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected tool error (Tier 1 should not allow move)")
	}
	if !strings.Contains(flattenContent(res), "no_grant") {
		t.Errorf("expected no_grant in error: %s", flattenContent(res))
	}
}

func TestTool_MoveNote_AllowedAtTier2(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierFull, "test"); err != nil {
		t.Fatalf("Set grant: %v", err)
	}
	summary, err := f.NotesSvc.Create(context.Background(), "projects", "src2")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	f.NotesProv.notes = []notes.NoteSummary{{ID: summary.ID, Path: summary.Path, Title: summary.Title}}
	res, err := f.callTool(t, "move_note", map[string]any{
		"path":     summary.Path,
		"new_path": "projects/dst2.md",
	})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", flattenContent(res))
	}
}

func TestTool_DeleteNote_DeniedAtTier1(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
		t.Fatalf("Set grant: %v", err)
	}
	summary, err := f.NotesSvc.Create(context.Background(), "projects", "doomed")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	f.NotesProv.notes = []notes.NoteSummary{{ID: summary.ID, Path: summary.Path, Title: summary.Title}}
	res, err := f.callTool(t, "delete_note", map[string]any{"path": summary.Path})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected tool error (Tier 1 should not allow delete)")
	}
	if !strings.Contains(flattenContent(res), "no_grant") {
		t.Errorf("expected no_grant in error: %s", flattenContent(res))
	}
}

func TestTool_DeleteNote_AllowedAtTier2(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierFull, "test"); err != nil {
		t.Fatalf("Set grant: %v", err)
	}
	summary, err := f.NotesSvc.Create(context.Background(), "projects", "doomed2")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	f.NotesProv.notes = []notes.NoteSummary{{ID: summary.ID, Path: summary.Path, Title: summary.Title}}
	res, err := f.callTool(t, "delete_note", map[string]any{"path": summary.Path})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", flattenContent(res))
	}
}

type failingWriteStore struct {
	inner       *fsstore.Store
	allowWrites int
	writeCalls  int
}

func (f *failingWriteStore) Read(p string) ([]byte, error) { return f.inner.Read(p) }
func (f *failingWriteStore) WriteAtomic(p string, data []byte) error {
	f.writeCalls++
	if f.writeCalls > f.allowWrites {
		return errors.New("simulated WriteAtomic failure (test injection)")
	}
	return f.inner.WriteAtomic(p, data)
}
func (f *failingWriteStore) Stat(p string) (time.Time, error) { return f.inner.Stat(p) }

func (f *failingWriteStore) CreateFile(p string) error { return f.inner.CreateFile(p) }

func (f *failingWriteStore) DeleteFile(p string) error { return f.inner.DeleteFile(p) }

func (f *failingWriteStore) MoveFile(o, n string) error { return f.inner.MoveFile(o, n) }
func (f *failingWriteStore) CreateDir(p string) error   { return f.inner.CreateDir(p) }
func (f *failingWriteStore) DeleteDir(p string, recursive bool) error {
	return f.inner.DeleteDir(p, recursive)
}

func (f *failingWriteStore) MoveDir(o, n string) error { return f.inner.MoveDir(o, n) }

func (f *failingWriteStore) TrashFile(p string) (string, error) { return f.inner.TrashFile(p) }
func (f *failingWriteStore) TrashDir(p string) (string, error)  { return f.inner.TrashDir(p) }

// TestCreateNoteAtomic — create_note composes scaffold+body in memory and
// writes ONCE via WriteAtomic. No partial scaffold-only file lands on disk
// under any failure mode reachable from the MCP handler. Error codes
// distinguish {already_exists, invalid_path, internal}; the legacy
// partial_create code is unreachable from this path.
func TestCreateNoteAtomic(t *testing.T) {
	t.Parallel()

	t.Run("success: scaffold+body in one write", func(t *testing.T) {
		t.Parallel()
		f := newTestServer(t)
		if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
			t.Fatalf("Set grant: %v", err)
		}
		body := "First line of body.\n\n```go\nfunc main(){println(\"hello\")}\n```\n\nSecond paragraph.\n"
		res, err := f.callTool(t, "create_note", map[string]any{
			"path": "projects/atomic.md",
			"body": body,
		})
		if err != nil {
			t.Fatalf("CallTool: %v", err)
		}
		if res.IsError {
			t.Fatalf("tool error: %v", flattenContent(res))
		}

		got, readErr := os.ReadFile(filepath.Join(f.Root, "projects", "atomic.md"))
		if readErr != nil {
			t.Fatalf("expected projects/atomic.md on disk: %v", readErr)
		}

		wantPrefix := "---\ntags: []\n---\n\n# atomic\n\n"
		if !strings.HasPrefix(string(got), wantPrefix) {
			t.Errorf("file missing canonical scaffold prefix.\n got=%q\n want prefix=%q", string(got), wantPrefix)
		}

		want := wantPrefix + body
		if string(got) != want {
			t.Errorf("scaffold+body byte mismatch.\n got=%q\n want=%q", string(got), want)
		}

		text := flattenContent(res)
		if !strings.Contains(text, `"updated_at":`) {
			t.Errorf("expected updated_at in response: %s", text)
		}

		if strings.Contains(text, "partial_create") {
			t.Errorf("R4-2 regression: response contains partial_create: %s", text)
		}
	})

	t.Run("write fails: no partial file lands on disk", func(t *testing.T) {
		t.Parallel()

		root := t.TempDir()
		if err := os.MkdirAll(filepath.Join(root, "projects"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		failStore := &failingWriteStore{inner: fsstore.NewStore(root), allowWrites: 0}
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		notesSvc := notes.NewService(failStore, nil, nil, logger)
		acl := mcp.NewACL(openTestDB(t))
		if _, err := acl.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
			t.Fatalf("Set grant: %v", err)
		}
		srv := mcp.NewServer(notesSvc, &fakeNotesProvider{}, &fakeSearchProvider{}, &fakeAttachProvider{}, acl, nil, logger)
		f := &testServerFixture{Server: srv, NotesSvc: notesSvc, ACL: acl, Root: root}

		res, err := f.callTool(t, "create_note", map[string]any{
			"path": "projects/fail.md",
			"body": "this body never lands",
		})
		if err != nil {
			t.Fatalf("CallTool: %v", err)
		}
		if !res.IsError {
			t.Fatal("expected tool error from WriteAtomic injection")
		}
		text := flattenContent(res)

		if !strings.Contains(text, "internal") {
			t.Errorf("expected 'internal' in error: %s", text)
		}

		if strings.Contains(text, "partial_create") {
			t.Errorf("R4-2 regression: error contains partial_create: %s", text)
		}

		path := filepath.Join(root, "projects", "fail.md")
		if _, statErr := os.Stat(path); statErr == nil {
			contents, _ := os.ReadFile(path)
			t.Errorf("R4-1 regression: partial file exists at %s after failed WriteAtomic.\n contents=%q", path, string(contents))
		} else if !os.IsNotExist(statErr) {
			t.Errorf("unexpected stat error: %v", statErr)
		}
	})

	t.Run("already_exists: collision returns distinct error code", func(t *testing.T) {
		t.Parallel()
		f := newTestServer(t)
		if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
			t.Fatalf("Set grant: %v", err)
		}

		res1, err := f.callTool(t, "create_note", map[string]any{
			"path": "projects/dupe.md",
			"body": "first body",
		})
		if err != nil {
			t.Fatalf("first CallTool: %v", err)
		}
		if res1.IsError {
			t.Fatalf("first call: tool error: %v", flattenContent(res1))
		}
		firstBytes, err := os.ReadFile(filepath.Join(f.Root, "projects", "dupe.md"))
		if err != nil {
			t.Fatalf("first read: %v", err)
		}

		res2, err := f.callTool(t, "create_note", map[string]any{
			"path": "projects/dupe.md",
			"body": "would clobber",
		})
		if err != nil {
			t.Fatalf("second CallTool: %v", err)
		}
		if !res2.IsError {
			t.Fatal("expected already_exists error on duplicate path")
		}
		text := flattenContent(res2)
		if !strings.Contains(text, "already_exists") {
			t.Errorf("expected 'already_exists' in error: %s", text)
		}

		secondBytes, _ := os.ReadFile(filepath.Join(f.Root, "projects", "dupe.md"))
		if string(firstBytes) != string(secondBytes) {
			t.Errorf("file mutated by failed second create.\n first=%q\n second=%q", firstBytes, secondBytes)
		}
	})
}

// TestListGrants verifies the list_grants tool returns every explicit
// folder grant, sorted alphabetically by path, with tier values and
// RFC3339 timestamps. list_grants surfaces ONLY explicit grants —
// clients compute recursive inheritance themselves.
func TestListGrants(t *testing.T) {
	t.Parallel()

	t.Run("empty grants returns empty array", func(t *testing.T) {
		t.Parallel()
		f := newTestServer(t)
		res, err := f.callTool(t, "list_grants", map[string]any{})
		if err != nil {
			t.Fatalf("CallTool: %v", err)
		}
		if res.IsError {
			t.Fatalf("tool error: %v", flattenContent(res))
		}
		text := flattenContent(res)
		if !strings.Contains(text, `"grants":[]`) {
			t.Errorf("expected empty grants array, got: %s", text)
		}
	})

	t.Run("two grants returned sorted with correct tiers", func(t *testing.T) {
		t.Parallel()
		f := newTestServer(t)
		ctx := context.Background()

		if _, err := f.ACL.Set(ctx, "zeta", mcp.TierFull, "test"); err != nil {
			t.Fatalf("Set zeta: %v", err)
		}
		if _, err := f.ACL.Set(ctx, "alpha", mcp.TierEditOnly, "test"); err != nil {
			t.Fatalf("Set alpha: %v", err)
		}
		res, err := f.callTool(t, "list_grants", map[string]any{})
		if err != nil {
			t.Fatalf("CallTool: %v", err)
		}
		if res.IsError {
			t.Fatalf("tool error: %v", flattenContent(res))
		}
		text := flattenContent(res)

		alphaIdx := strings.Index(text, `"alpha"`)
		zetaIdx := strings.Index(text, `"zeta"`)
		if alphaIdx < 0 || zetaIdx < 0 {
			t.Fatalf("missing grants in output: %s", text)
		}
		if alphaIdx > zetaIdx {
			t.Errorf("expected alpha before zeta in sorted output; got: %s", text)
		}

		if !strings.Contains(text, `"tier":1`) {
			t.Errorf("expected tier=1 for alpha grant: %s", text)
		}
		if !strings.Contains(text, `"tier":2`) {
			t.Errorf("expected tier=2 for zeta grant: %s", text)
		}

		if !strings.Contains(text, "T") || !strings.Contains(text, "Z") {
			t.Errorf("expected RFC3339 timestamp in grants: %s", text)
		}
	})
}

// TestCreateNoteTitleParam verifies the optional `title` param overrides
// the scaffold H1 while the filename stays slugified from the path.
func TestCreateNoteTitleParam(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
		t.Fatalf("Set grant: %v", err)
	}
	res, err := f.callTool(t, "create_note", map[string]any{
		"path":  "projects/some-slug.md",
		"title": "My Friendly Title",
	})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", flattenContent(res))
	}

	filePath := filepath.Join(f.Root, "projects", "some-slug.md")
	contents, readErr := os.ReadFile(filePath)
	if readErr != nil {
		t.Fatalf("expected projects/some-slug.md on disk: %v", readErr)
	}

	if !strings.Contains(string(contents), "# My Friendly Title") {
		t.Errorf("expected '# My Friendly Title' H1 in file; got: %q", string(contents))
	}

	if strings.Contains(string(contents), "# some-slug") {
		t.Errorf("filename-derived H1 leaked into scaffold despite title override: %q", string(contents))
	}
}

// TestCreateNoteTitleParam_Sanitization verifies that newlines + control
// chars are stripped and whitespace collapsed before embedding in the H1.
func TestCreateNoteTitleParam_Sanitization(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
		t.Fatalf("Set grant: %v", err)
	}
	res, err := f.callTool(t, "create_note", map[string]any{
		"path":  "projects/sanitize-me.md",
		"title": "  Title\nwith\tcontrol\x01chars  ",
	})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", flattenContent(res))
	}
	contents, _ := os.ReadFile(filepath.Join(f.Root, "projects", "sanitize-me.md"))

	if !strings.Contains(string(contents), "# Title with control chars") {
		t.Errorf("expected sanitized H1; got: %q", string(contents))
	}
}

// TestUpdateNoteIfMatchWildcard verifies that if_match="*" bypasses the
// stale-write check and surfaces force_write: true in the response. With
// a literal stale tag (not "*"), the legacy conflict behaviour still fires.
func TestUpdateNoteIfMatchWildcard(t *testing.T) {
	t.Parallel()

	t.Run("wildcard succeeds and surfaces force_write true", func(t *testing.T) {
		t.Parallel()
		f := newTestServer(t)
		if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
			t.Fatalf("Set grant: %v", err)
		}
		summary, err := f.NotesSvc.Create(context.Background(), "projects", "wild")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		f.NotesProv.notes = []notes.NoteSummary{{ID: summary.ID, Path: summary.Path, Title: summary.Title}}

		res, err := f.callTool(t, "update_note", map[string]any{
			"path":     summary.Path,
			"body":     "last writer wins body",
			"if_match": "*",
		})
		if err != nil {
			t.Fatalf("CallTool: %v", err)
		}
		if res.IsError {
			t.Fatalf("tool error: %v", flattenContent(res))
		}
		text := flattenContent(res)
		if !strings.Contains(text, `"force_write":true`) {
			t.Errorf("expected force_write:true in response: %s", text)
		}
	})

	t.Run("literal stale tag still returns conflict", func(t *testing.T) {
		t.Parallel()
		f := newTestServer(t)
		if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
			t.Fatalf("Set grant: %v", err)
		}
		summary, err := f.NotesSvc.Create(context.Background(), "projects", "wild-stale")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		f.NotesProv.notes = []notes.NoteSummary{{ID: summary.ID, Path: summary.Path, Title: summary.Title}}

		staleTag := time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339Nano)
		res, err := f.callTool(t, "update_note", map[string]any{
			"path":     summary.Path,
			"body":     "would clobber",
			"if_match": staleTag,
		})
		if err != nil {
			t.Fatalf("CallTool: %v", err)
		}
		if !res.IsError {
			t.Fatal("expected conflict error for stale literal If-Match")
		}
		text := flattenContent(res)
		if !strings.Contains(text, "conflict") {
			t.Errorf("expected 'conflict' in error: %s", text)
		}

		if strings.Contains(text, `"force_write":true`) {
			t.Errorf("force_write must not appear on conflict path: %s", text)
		}
	})
}

// TestCreateNoteRespectsTestDelay verifies that the debug-only
// JASPER_MCP_TEST_DELAY env var widens the create_note write window by the
// configured number of milliseconds. The hook exists exclusively so the
// phase8-mcp-vault-switch.spec.ts deterministic-timing test can reproduce
// the V-TEST-4 race; production builds never set this env var.
func TestCreateNoteRespectsTestDelay(t *testing.T) {
	const delayMS = 200
	t.Setenv("JASPER_MCP_TEST_DELAY", strconv.Itoa(delayMS))
	f := newTestServer(t)
	if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
		t.Fatalf("Set grant: %v", err)
	}
	start := time.Now()
	res, err := f.callTool(t, "create_note", map[string]any{
		"path": "projects/delayed.md",
	})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", flattenContent(res))
	}
	if elapsed < time.Duration(delayMS)*time.Millisecond {
		t.Errorf("expected create_note to sleep >= %dms with JASPER_MCP_TEST_DELAY=%d; got %v",
			delayMS, delayMS, elapsed)
	}

	if _, err := os.Stat(filepath.Join(f.Root, "projects", "delayed.md")); err != nil {
		t.Errorf("expected projects/delayed.md on disk after throttled create: %v", err)
	}
}

func flattenContent(res *mcpsdk.CallToolResult) string {
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcpsdk.TextContent); ok {
			sb.WriteString(tc.Text)
			sb.WriteString("\n")
		}
	}
	if res.StructuredContent != nil {
		sb.WriteString(toJSONString(res.StructuredContent))
	}
	return sb.String()
}

func toJSONString(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}
