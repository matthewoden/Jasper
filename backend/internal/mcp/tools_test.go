package mcp_test

// Plan 08-09 — tools_test.go covers tool dispatch behavior:
//
//  1. list_notes happy path
//  2. read_note by ID + by path
//  3. search_notes calls the provider with the query
//  4. read_attachment round-trip with the 5-rule path pipeline
//  5. read_attachment rejects "../escape.png" (path-separator guard)
//  6. create_note denied when no grant → error contains "no_grant"
//  7. create_note allowed when Tier-1 grant covers the folder
//  8. update_note denied / allowed at Tier 1
//  9. move_note denied at Tier 1; allowed at Tier 2
// 10. delete_note denied at Tier 1; allowed at Tier 2
// 11. update_note with stale If-Match → conflict error w/ latest_updated_at

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/mcp"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// ---------- fakes ----------

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

// ---------- fixture builder ----------

// buildToolFixture returns a real notes.Service backed by a tempdir
// fsstore + the four fakes the MCP server consumes. The notes.Service
// uses nil index (nopIndex) so registry behavior is exercised.
func buildToolFixture(t *testing.T) (*notes.Service, string, *fakeNotesProvider, string) {
	t.Helper()
	root := t.TempDir()
	// Phase 8 Plan 08-09: notes.Service expects <dataDir>/notes/ to exist.
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir root: %v", err)
	}
	store := fsstore.NewStore(root)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := notes.NewService(store, nil, nil, logger)
	provider := &fakeNotesProvider{}
	// Seed a folder so we can grant on "projects" without create needing
	// the parent to exist via the single-level mkdir policy.
	if err := os.MkdirAll(filepath.Join(root, "projects"), 0o755); err != nil {
		t.Fatalf("mkdir projects: %v", err)
	}
	return svc, root, provider, root
}

// newTestServer constructs an MCP server with fakes + a real notes.Service.
// Tests obtain references to the underlying fakes via the returned struct.
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

// callTool runs a tool call against the in-process SDK via the in-memory
// transport — the same code path Claude Desktop uses, but with the test
// owning both ends of the wire.
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

// ---------- 1. list_notes ----------

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
	// Structured content carries the result; the SDK serializes Out
	// (ListNotesResult) into StructuredContent. We assert the embedded
	// JSON text content contains the note id + path.
	text := flattenContent(res)
	if !strings.Contains(text, id.String()) {
		t.Errorf("output missing id %s: %s", id.String(), text)
	}
	if !strings.Contains(text, "projects/alpha.md") {
		t.Errorf("output missing path: %s", text)
	}
}

// ---------- 2. read_note by ID + by path ----------

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
	// Seed provider so resolveNoteID can find the path.
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

// ---------- 3. search_notes ----------

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

// ---------- 4. read_attachment round-trip ----------

func TestTool_ReadAttachment_RoundTrip(t *testing.T) {
	t.Parallel()
	// Compose: real notes.Service so LookupSummary returns the note;
	// real NewAttachmentAdapter pointed at a real tempdir tree with a
	// known attachment file. The test asserts the tool returns the
	// exact bytes base64-encoded + correct mime.
	root := t.TempDir()
	notesRoot := filepath.Join(root, "notes")
	folderDir := filepath.Join(notesRoot, "projects", "myfolder")
	attachDir := filepath.Join(folderDir, "attachments")
	if err := os.MkdirAll(attachDir, 0o755); err != nil {
		t.Fatalf("mkdir attachments: %v", err)
	}
	// Write the note .md so notes.Service.Create can resolve the file.
	store := fsstore.NewStore(notesRoot)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	notesSvc := notes.NewService(store, nil, nil, logger)
	summary, err := notesSvc.Create(context.Background(), "projects/myfolder", "note")
	if err != nil {
		t.Fatalf("Create note: %v", err)
	}

	// PNG magic + a few payload bytes — exact bytes we expect back.
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
	// Decode the base64 from the structured content. The SDK emits the
	// Out struct as a JSON blob with a "base64" field; we hunt for it.
	wantB64 := base64.StdEncoding.EncodeToString(pngBytes)
	if !strings.Contains(text, wantB64) {
		t.Errorf("expected base64 of pngBytes in output. want=%s got=%s", wantB64, text)
	}
}

func TestTool_ReadAttachment_RejectsTraversal(t *testing.T) {
	t.Parallel()
	// Same setup as round-trip but call with "../escape.png" — the
	// 5-rule pipeline must reject before any file access.
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

// ---------- 5. create_note ACL gate ----------

func TestTool_CreateNote_DeniedWithoutGrant(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	// No grant — expect no_grant error.
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
	// Verify the file landed on disk under the test root.
	if _, err := os.Stat(filepath.Join(f.Root, "projects", "x.md")); err != nil {
		t.Errorf("expected projects/x.md on disk: %v", err)
	}
}

// ---------- 6. update_note ACL + If-Match ----------

func TestTool_UpdateNote_DeniedWithoutGrant(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	// Pre-seed a note via the service (bypass MCP so no grant required).
	summary, err := f.NotesSvc.Create(context.Background(), "projects", "x")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	f.NotesProv.notes = []notes.NoteSummary{{ID: summary.ID, Path: summary.Path, Title: summary.Title}}
	// No grant — update_note should deny.
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

	// Stale If-Match — a time before the note's actual mtime.
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

// ---------- 7. move_note Tier-1 deny / Tier-2 allow ----------

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

// ---------- 8. delete_note Tier-1 deny / Tier-2 allow ----------

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

// ---------- helpers ----------

// flattenContent collects every text payload from a CallToolResult into
// a single string so assertions can grep for substrings.
func flattenContent(res *mcpsdk.CallToolResult) string {
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcpsdk.TextContent); ok {
			sb.WriteString(tc.Text)
			sb.WriteString("\n")
		}
	}
	if res.StructuredContent != nil {
		// StructuredContent is the typed Out value; the SDK already
		// includes it as JSON in res.Content for compatibility. Belt
		// and suspenders: stringify it explicitly so tests can still
		// match on field values even if Content is nil.
		sb.WriteString(toJSONString(res.StructuredContent))
	}
	return sb.String()
}

// toJSONString is a tiny helper; tests use it to coerce structured
// content into a searchable blob. Errors swallowed — assertions catch
// mismatched expectations downstream.
func toJSONString(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}
