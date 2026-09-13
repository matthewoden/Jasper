package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// newAttachmentMoveServer is setupRealFSServer with a real dataDir, which the
// attachment routes need in order to resolve <dataDir>/notes/<folder>/attachments.
func newAttachmentMoveServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dataDir := t.TempDir()
	notesDir := filepath.Join(dataDir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("MkdirAll notesDir: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, ".trash"), 0o755); err != nil {
		t.Fatalf("MkdirAll trashDir: %v", err)
	}
	store := fsstore.NewStore(notesDir)
	idx := newRealIndex()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := notes.NewService(store, idx, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, dataDir)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(NewStrictHandler(srv, nil), r)
	})
	return httptest.NewServer(r), notesDir
}

// createNoteWithBody creates a note through the API, then writes body straight
// to disk. The relocation path reads the file, so going around PUT keeps the
// test free of If-Match plumbing it is not exercising.
func createNoteWithBody(t *testing.T, ts *httptest.Server, notesDir, parent, title, body string) (id, relPath string) {
	t.Helper()
	req := `{"parent_path":"` + parent + `","title":"` + title + `"}`
	resp, respBody := mustPostJSON(t, ts, "/api/v1/notes", req)
	if resp.StatusCode >= 300 {
		t.Fatalf("create note %q: %d %s", title, resp.StatusCode, respBody)
	}
	var created struct {
		ID   string `json:"id"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(respBody, &created); err != nil {
		t.Fatalf("unmarshal create response: %v", err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, created.Path), []byte(body), 0o644); err != nil {
		t.Fatalf("write note body: %v", err)
	}
	return created.ID, created.Path
}

func writeAttachment(t *testing.T, notesDir, folder, name string, data []byte) string {
	t.Helper()
	dir := filepath.Join(notesDir, folder, "attachments")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll %s: %v", dir, err)
	}
	abs := filepath.Join(dir, name)
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		t.Fatalf("write attachment: %v", err)
	}
	return abs
}

func getAttachmentStatus(t *testing.T, ts *httptest.Server, noteID, filename string) int {
	t.Helper()
	resp, err := http.Get(ts.URL + "/api/v1/attachments/" + noteID + "/" + filename)
	if err != nil {
		t.Fatalf("GET attachment: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return resp.StatusCode
}

func moveNote(t *testing.T, ts *httptest.Server, id, newPath string) {
	t.Helper()
	resp, body := mustPostJSON(t, ts, "/api/v1/notes/"+id+"/move", `{"new_path":"`+newPath+`"}`)
	if resp.StatusCode >= 300 {
		t.Fatalf("move note: %d %s", resp.StatusCode, body)
	}
}

// TestMovedNoteKeepsItsAttachments is the regression for the defect where a
// note moved between folders silently lost every image it embedded: the
// reference is folder-relative but served against the note's current parent.
func TestMovedNoteKeepsItsAttachments(t *testing.T) {
	ts, notesDir := newAttachmentMoveServer(t)
	defer ts.Close()

	if resp, body := mustPostJSON(t, ts, "/api/v1/folders", `{"parent_path":"","name":"sub"}`); resp.StatusCode >= 300 {
		t.Fatalf("create folder: %d %s", resp.StatusCode, body)
	}
	id, _ := createNoteWithBody(t, ts, notesDir, "sub", "photo-note",
		"# photo-note\n\n![pic.png](attachments/pic.png)\n")
	writeAttachment(t, notesDir, "sub", "pic.png", []byte("\x89PNG\r\n\x1a\noriginal"))

	if got := getAttachmentStatus(t, ts, id, "pic.png"); got != http.StatusOK {
		t.Fatalf("precondition: want 200 before move, got %d", got)
	}

	moveNote(t, ts, id, "photo-note.md")

	if got := getAttachmentStatus(t, ts, id, "pic.png"); got != http.StatusOK {
		t.Errorf("after move: want 200, got %d", got)
	}
	if _, err := os.Stat(filepath.Join(notesDir, "attachments", "pic.png")); err != nil {
		t.Errorf("attachment should have travelled to the destination folder: %v", err)
	}
	if _, err := os.Stat(filepath.Join(notesDir, "sub", "attachments", "pic.png")); !os.IsNotExist(err) {
		t.Errorf("attachment should no longer be in the source folder, stat err = %v", err)
	}

	body, err := os.ReadFile(filepath.Join(notesDir, "photo-note.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte("(attachments/pic.png)")) {
		t.Errorf("reference text should be untouched, got:\n%s", body)
	}
}

// TestMovedNoteCopiesAttachmentSharedWithSibling covers the shared-directory
// case: attachments/ belongs to the folder, not to one note, so a file another
// note still embeds must not be moved out from under it.
func TestMovedNoteCopiesAttachmentSharedWithSibling(t *testing.T) {
	ts, notesDir := newAttachmentMoveServer(t)
	defer ts.Close()

	if resp, body := mustPostJSON(t, ts, "/api/v1/folders", `{"parent_path":"","name":"sub"}`); resp.StatusCode >= 300 {
		t.Fatalf("create folder: %d %s", resp.StatusCode, body)
	}
	moverID, _ := createNoteWithBody(t, ts, notesDir, "sub", "mover",
		"# mover\n\n![shared.png](attachments/shared.png)\n")
	stayerID, _ := createNoteWithBody(t, ts, notesDir, "sub", "stayer",
		"# stayer\n\n![shared.png](attachments/shared.png)\n")
	writeAttachment(t, notesDir, "sub", "shared.png", []byte("\x89PNG\r\n\x1a\nshared"))

	moveNote(t, ts, moverID, "mover.md")

	if got := getAttachmentStatus(t, ts, moverID, "shared.png"); got != http.StatusOK {
		t.Errorf("moved note: want 200, got %d", got)
	}
	if got := getAttachmentStatus(t, ts, stayerID, "shared.png"); got != http.StatusOK {
		t.Errorf("note left behind: want 200, got %d", got)
	}
	for _, p := range []string{
		filepath.Join(notesDir, "attachments", "shared.png"),
		filepath.Join(notesDir, "sub", "attachments", "shared.png"),
	} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("expected a copy at %s: %v", p, err)
		}
	}
}

// TestMovedNoteRenamesCollidingAttachment covers a destination that already
// holds the same filename: the incoming file takes a -N suffix and that one
// reference is rewritten, rather than clobbering an unrelated file.
func TestMovedNoteRenamesCollidingAttachment(t *testing.T) {
	ts, notesDir := newAttachmentMoveServer(t)
	defer ts.Close()

	if resp, body := mustPostJSON(t, ts, "/api/v1/folders", `{"parent_path":"","name":"sub"}`); resp.StatusCode >= 300 {
		t.Fatalf("create folder: %d %s", resp.StatusCode, body)
	}
	id, _ := createNoteWithBody(t, ts, notesDir, "sub", "photo-note",
		"# photo-note\n\n![pic.png](attachments/pic.png)\n")
	writeAttachment(t, notesDir, "sub", "pic.png", []byte("incoming"))
	rootPic := writeAttachment(t, notesDir, "", "pic.png", []byte("unrelated-occupant"))

	moveNote(t, ts, id, "photo-note.md")

	occupant, err := os.ReadFile(rootPic)
	if err != nil {
		t.Fatalf("read occupant: %v", err)
	}
	if string(occupant) != "unrelated-occupant" {
		t.Errorf("destination occupant was clobbered, now %q", occupant)
	}

	relocated, err := os.ReadFile(filepath.Join(notesDir, "attachments", "pic-1.png"))
	if err != nil {
		t.Fatalf("expected the incoming file at attachments/pic-1.png: %v", err)
	}
	if string(relocated) != "incoming" {
		t.Errorf("relocated file has wrong bytes: %q", relocated)
	}

	body, err := os.ReadFile(filepath.Join(notesDir, "photo-note.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte("(attachments/pic-1.png)")) {
		t.Errorf("reference should have been rewritten to pic-1.png, got:\n%s", body)
	}
	if got := getAttachmentStatus(t, ts, id, "pic-1.png"); got != http.StatusOK {
		t.Errorf("rewritten reference should resolve: got %d", got)
	}
}

// TestRenameInPlaceLeavesAttachmentsAlone guards the early return: a rename
// that does not change folder must touch no files.
func TestRenameInPlaceLeavesAttachmentsAlone(t *testing.T) {
	ts, notesDir := newAttachmentMoveServer(t)
	defer ts.Close()

	if resp, body := mustPostJSON(t, ts, "/api/v1/folders", `{"parent_path":"","name":"sub"}`); resp.StatusCode >= 300 {
		t.Fatalf("create folder: %d %s", resp.StatusCode, body)
	}
	id, _ := createNoteWithBody(t, ts, notesDir, "sub", "before",
		"# before\n\n![pic.png](attachments/pic.png)\n")
	writeAttachment(t, notesDir, "sub", "pic.png", []byte("\x89PNG\r\n\x1a\nstill here"))

	moveNote(t, ts, id, "sub/after.md")

	if _, err := os.Stat(filepath.Join(notesDir, "sub", "attachments", "pic.png")); err != nil {
		t.Errorf("attachment should not have moved: %v", err)
	}
	if got := getAttachmentStatus(t, ts, id, "pic.png"); got != http.StatusOK {
		t.Errorf("want 200 after in-place rename, got %d", got)
	}
}
