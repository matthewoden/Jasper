package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// setupBookmarksTestServer wires a real notes.Service (so a note can be
// created via POST /api/v1/notes and registered in the registry) plus a
// bookmarks.Service backed by a real <dataDir>/.jasper/bookmarks.json —
// unlike setupRealFSServer, dataDir must be non-empty and its .jasper/
// directory must already exist (fsstore.AtomicWrite's caller-must-mkdir
// contract).
func setupBookmarksTestServer(t *testing.T) (*httptest.Server, *apiBroadcaster) {
	t.Helper()
	dataDir := t.TempDir()
	notesDir := filepath.Join(dataDir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("MkdirAll notesDir: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, ".jasper"), 0o755); err != nil {
		t.Fatalf("MkdirAll .jasper: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, ".trash"), 0o755); err != nil {
		t.Fatalf("MkdirAll .trash: %v", err)
	}

	store := fsstore.NewStore(notesDir)
	idx := newRealIndex()
	bc := &apiBroadcaster{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := notes.NewService(store, idx, bc, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, bc, logger, dataDir)
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r), bc
}

// mustCreateNote creates a note via POST /api/v1/notes and returns its id.
func mustCreateNote(t *testing.T, ts *httptest.Server, title string) string {
	t.Helper()
	resp, body := mustPostJSON(t, ts, "/api/v1/notes", `{"parent_path":"","title":"`+title+`"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create note: %d; body=%s", resp.StatusCode, body)
	}
	var got struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	return got.ID
}

// TestPostBookmark_HappyPath_201 — bookmarking a real, registered note
// succeeds and broadcasts bookmark:changed.
func TestPostBookmark_HappyPath_201(t *testing.T) {
	t.Parallel()
	ts, bc := setupBookmarksTestServer(t)
	defer ts.Close()

	noteID := mustCreateNote(t, ts, "alpha")

	resp, body := mustPostJSON(t, ts, "/api/v1/bookmarks", `{"note_id":"`+noteID+`"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("status: got %d, want 201; body=%s", resp.StatusCode, body)
	}
	var got Bookmark
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.NoteId.String() != noteID {
		t.Errorf("NoteId: got %q, want %q", got.NoteId.String(), noteID)
	}
	if got.FolderId != nil {
		t.Errorf("FolderId: got %v, want nil", got.FolderId)
	}

	bc.mu.Lock()
	n := len(bc.events)
	last := bc.events[len(bc.events)-1]
	bc.mu.Unlock()
	if n == 0 {
		t.Fatalf("expected at least one broadcast event")
	}
	if last.eventType != "bookmark:changed" {
		t.Errorf("eventType: got %q, want %q", last.eventType, "bookmark:changed")
	}
}

// TestPostBookmark_UnregisteredNoteId_404: a forged/unknown
// note_id (never created, never in the registry) is rejected with 404,
// not silently persisted.
func TestPostBookmark_UnregisteredNoteId_404(t *testing.T) {
	t.Parallel()
	ts, _ := setupBookmarksTestServer(t)
	defer ts.Close()

	forged := uuid.NewString()
	resp, body := mustPostJSON(t, ts, "/api/v1/bookmarks", `{"note_id":"`+forged+`"}`)
	if resp.StatusCode != 404 {
		t.Fatalf("status: got %d, want 404; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "not_found" {
		t.Errorf("Code: got %q, want %q", got.Code, "not_found")
	}

	// Verify nothing was persisted: GET /bookmarks returns an empty set.
	resp, body = http200Get(t, ts, "/api/v1/bookmarks")
	if resp.StatusCode != 200 {
		t.Fatalf("GET status: got %d; body=%s", resp.StatusCode, body)
	}
	var doc BookmarksDocument
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if len(doc.Bookmarks) != 0 {
		t.Errorf("Bookmarks: got %d, want 0 (forged noteId must not persist)", len(doc.Bookmarks))
	}
}

// TestPostBookmark_UnknownFolderId_400 — a folder_id that doesn't exist in
// the document is rejected with 400.
func TestPostBookmark_UnknownFolderId_400(t *testing.T) {
	t.Parallel()
	ts, _ := setupBookmarksTestServer(t)
	defer ts.Close()

	noteID := mustCreateNote(t, ts, "alpha")
	unknownFolder := uuid.NewString()

	resp, body := mustPostJSON(t, ts, "/api/v1/bookmarks",
		`{"note_id":"`+noteID+`","folder_id":"`+unknownFolder+`"}`)
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "invalid_request" {
		t.Errorf("Code: got %q, want %q", got.Code, "invalid_request")
	}
}

// TestGetBookmarks_ReturnsWholeDocument_200 — GET returns both folders and
// bookmarks after mutations.
func TestGetBookmarks_ReturnsWholeDocument_200(t *testing.T) {
	t.Parallel()
	ts, _ := setupBookmarksTestServer(t)
	defer ts.Close()

	noteID := mustCreateNote(t, ts, "alpha")
	folderID := mustCreateBookmarkFolder(t, ts, "Work")

	if resp, body := mustPostJSON(t, ts, "/api/v1/bookmarks",
		`{"note_id":"`+noteID+`","folder_id":"`+folderID+`"}`); resp.StatusCode != 201 {
		t.Fatalf("create bookmark: %d; body=%s", resp.StatusCode, body)
	}

	resp, body := http200Get(t, ts, "/api/v1/bookmarks")
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d; body=%s", resp.StatusCode, body)
	}
	var doc BookmarksDocument
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if len(doc.Folders) != 1 {
		t.Fatalf("Folders: got %d, want 1", len(doc.Folders))
	}
	if len(doc.Bookmarks) != 1 {
		t.Fatalf("Bookmarks: got %d, want 1", len(doc.Bookmarks))
	}
	if doc.Bookmarks[0].FolderId == nil || doc.Bookmarks[0].FolderId.String() != folderID {
		t.Errorf("Bookmarks[0].FolderId: got %v, want %q", doc.Bookmarks[0].FolderId, folderID)
	}
}

// TestDeleteBookmark_HappyPath_204 — deleting an existing bookmark succeeds.
func TestDeleteBookmark_HappyPath_204(t *testing.T) {
	t.Parallel()
	ts, _ := setupBookmarksTestServer(t)
	defer ts.Close()

	noteID := mustCreateNote(t, ts, "alpha")
	resp, body := mustPostJSON(t, ts, "/api/v1/bookmarks", `{"note_id":"`+noteID+`"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d; body=%s", resp.StatusCode, body)
	}
	var created Bookmark
	_ = json.Unmarshal(body, &created)

	resp, body = mustDelete(t, ts, "/api/v1/bookmarks/"+created.Id.String())
	if resp.StatusCode != 204 {
		t.Fatalf("status: got %d, want 204; body=%s", resp.StatusCode, body)
	}
}

// TestDeleteBookmark_UnknownId_404 — deleting a never-created id returns 404.
func TestDeleteBookmark_UnknownId_404(t *testing.T) {
	t.Parallel()
	ts, _ := setupBookmarksTestServer(t)
	defer ts.Close()

	resp, body := mustDelete(t, ts, "/api/v1/bookmarks/"+uuid.NewString())
	if resp.StatusCode != 404 {
		t.Fatalf("status: got %d, want 404; body=%s", resp.StatusCode, body)
	}
	var got Error
	_ = json.Unmarshal(body, &got)
	if got.Code != "not_found" {
		t.Errorf("Code: got %q, want %q", got.Code, "not_found")
	}
}

// TestMoveBookmark_HappyPath_200 — moving a bookmark into a folder, then
// back to top-level (folder_id: null), succeeds both times.
func TestMoveBookmark_HappyPath_200(t *testing.T) {
	t.Parallel()
	ts, _ := setupBookmarksTestServer(t)
	defer ts.Close()

	noteID := mustCreateNote(t, ts, "alpha")
	folderID := mustCreateBookmarkFolder(t, ts, "Work")

	resp, body := mustPostJSON(t, ts, "/api/v1/bookmarks", `{"note_id":"`+noteID+`"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d; body=%s", resp.StatusCode, body)
	}
	var created Bookmark
	_ = json.Unmarshal(body, &created)

	resp, body = mustPostJSON(t, ts, "/api/v1/bookmarks/"+created.Id.String()+"/folder",
		`{"folder_id":"`+folderID+`"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("move into folder: %d; body=%s", resp.StatusCode, body)
	}
	var moved BookmarkMoveResponse
	_ = json.Unmarshal(body, &moved)
	if moved.FolderId == nil || moved.FolderId.String() != folderID {
		t.Errorf("FolderId: got %v, want %q", moved.FolderId, folderID)
	}

	resp, body = mustPostJSON(t, ts, "/api/v1/bookmarks/"+created.Id.String()+"/folder",
		`{"folder_id":null}`)
	if resp.StatusCode != 200 {
		t.Fatalf("move to top-level: %d; body=%s", resp.StatusCode, body)
	}
	var backToTop BookmarkMoveResponse
	_ = json.Unmarshal(body, &backToTop)
	if backToTop.FolderId != nil {
		t.Errorf("FolderId: got %v, want nil", backToTop.FolderId)
	}
}

// TestMoveBookmark_UnknownFolderId_400 — moving into a nonexistent folder
// returns 400.
func TestMoveBookmark_UnknownFolderId_400(t *testing.T) {
	t.Parallel()
	ts, _ := setupBookmarksTestServer(t)
	defer ts.Close()

	noteID := mustCreateNote(t, ts, "alpha")
	resp, body := mustPostJSON(t, ts, "/api/v1/bookmarks", `{"note_id":"`+noteID+`"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d; body=%s", resp.StatusCode, body)
	}
	var created Bookmark
	_ = json.Unmarshal(body, &created)

	resp, body = mustPostJSON(t, ts, "/api/v1/bookmarks/"+created.Id.String()+"/folder",
		`{"folder_id":"`+uuid.NewString()+`"}`)
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
}

// TestMoveBookmark_UnknownBookmarkId_404 — moving an unknown bookmark id
// returns 404.
func TestMoveBookmark_UnknownBookmarkId_404(t *testing.T) {
	t.Parallel()
	ts, _ := setupBookmarksTestServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/bookmarks/"+uuid.NewString()+"/folder", `{"folder_id":null}`)
	if resp.StatusCode != 404 {
		t.Fatalf("status: got %d, want 404; body=%s", resp.StatusCode, body)
	}
}

// TestCreateBookmarkFolder_HappyPath_201 — folder creation succeeds and
// broadcasts.
func TestCreateBookmarkFolder_HappyPath_201(t *testing.T) {
	t.Parallel()
	ts, bc := setupBookmarksTestServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/bookmark-folders", `{"name":"Work"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("status: got %d, want 201; body=%s", resp.StatusCode, body)
	}
	var got BookmarkFolder
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Name != "Work" {
		t.Errorf("Name: got %q, want %q", got.Name, "Work")
	}

	bc.mu.Lock()
	n := len(bc.events)
	bc.mu.Unlock()
	if n == 0 {
		t.Errorf("expected at least one broadcast event")
	}
}

// TestCreateBookmarkFolder_EmptyName_400 — whitespace-only name is rejected.
func TestCreateBookmarkFolder_EmptyName_400(t *testing.T) {
	t.Parallel()
	ts, _ := setupBookmarksTestServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/bookmark-folders", `{"name":"   "}`)
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	_ = json.Unmarshal(body, &got)
	if got.Code != "invalid_request" {
		t.Errorf("Code: got %q, want %q", got.Code, "invalid_request")
	}
}

// TestGetBookmarks_NilNotesService_DoesNotPanic:
// NewServerWithIndex(nil, ...) is a supported, tested pattern elsewhere in
// this package (Server's doc comment promises handlers degrade gracefully
// when notes is nil). Before the fix, GetBookmarks called
// s.notes.Registry() unconditionally — a nil *notes.Service receiver
// reading a field — and POST's Service.Add called s.registry.Lookup
// unconditionally — a nil *notes.Registry receiver locking r.mu — both of
// which panic.
func TestGetBookmarks_NilNotesService_DoesNotPanic(t *testing.T) {
	t.Parallel()
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, ".jasper"), 0o755); err != nil {
		t.Fatalf("MkdirAll .jasper: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServerWithIndex(nil, nil, nil, nil, nil, logger, dataDir)
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	ts := httptest.NewServer(r)
	defer ts.Close()

	resp, body := http200Get(t, ts, "/api/v1/bookmarks")
	if resp.StatusCode != 200 {
		t.Fatalf("GET /bookmarks with nil notes service: status = %d, want 200 (no panic); body=%s", resp.StatusCode, body)
	}
	var doc BookmarksDocument
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if len(doc.Bookmarks) != 0 || len(doc.Folders) != 0 {
		t.Errorf("GetBookmarks with nil notes service = %+v, want empty document", doc)
	}

	// POST must not panic on registry.Lookup either — expect a graceful
	// "not found" response (nothing can resolve without a registry), not a
	// crash.
	resp, body = mustPostJSON(t, ts, "/api/v1/bookmarks", `{"note_id":"`+uuid.NewString()+`"}`)
	if resp.StatusCode != 404 {
		t.Fatalf("POST /bookmarks with nil notes service: status = %d, want 404; body=%s", resp.StatusCode, body)
	}
}

func mustCreateBookmarkFolder(t *testing.T, ts *httptest.Server, name string) string {
	t.Helper()
	resp, body := mustPostJSON(t, ts, "/api/v1/bookmark-folders", `{"name":"`+name+`"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create bookmark folder: %d; body=%s", resp.StatusCode, body)
	}
	var got BookmarkFolder
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	return got.Id.String()
}

func http200Get(t *testing.T, ts *httptest.Server, path string) (*http.Response, []byte) {
	t.Helper()
	resp, err := http.Get(ts.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp, body
}

func TestRenameBookmarkFolder_HappyPath_200(t *testing.T) {
	t.Parallel()
	ts, bc := setupBookmarksTestServer(t)
	defer ts.Close()

	id := mustCreateBookmarkFolder(t, ts, "Work")
	bc.mu.Lock()
	before := len(bc.events)
	bc.mu.Unlock()

	resp, body := mustPutJSON(t, ts, "/api/v1/bookmark-folders/"+id, `{"name":"Personal"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got BookmarkFolder
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Id.String() != id || got.Name != "Personal" {
		t.Errorf("body: got %+v, want id %s name Personal", got, id)
	}

	bc.mu.Lock()
	after := len(bc.events)
	bc.mu.Unlock()
	if after <= before {
		t.Errorf("expected a broadcast event on rename")
	}
}

func TestRenameBookmarkFolder_EmptyName_400(t *testing.T) {
	t.Parallel()
	ts, _ := setupBookmarksTestServer(t)
	defer ts.Close()

	id := mustCreateBookmarkFolder(t, ts, "Work")
	resp, body := mustPutJSON(t, ts, "/api/v1/bookmark-folders/"+id, `{"name":"   "}`)
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
}

func TestRenameBookmarkFolder_UnknownId_404(t *testing.T) {
	t.Parallel()
	ts, _ := setupBookmarksTestServer(t)
	defer ts.Close()

	resp, body := mustPutJSON(t, ts, "/api/v1/bookmark-folders/"+uuid.NewString(), `{"name":"Personal"}`)
	if resp.StatusCode != 404 {
		t.Fatalf("status: got %d, want 404; body=%s", resp.StatusCode, body)
	}
}
