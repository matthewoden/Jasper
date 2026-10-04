package notes

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/markdown"
)

func readIDFromDisk(t *testing.T, root, rel string) ID {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	raw, found := markdown.ReadID(data)
	if !found {
		t.Fatalf("%s has no id line: %q", rel, data)
	}
	id, err := ParseID(raw)
	if err != nil {
		t.Fatalf("%s has a malformed id: %v", rel, err)
	}
	return id
}

// Criterion 1: a new note's file carries the id the service reports, and the
// scaffold is otherwise the standard one.
func TestService_Create_WritesIDIntoFile(t *testing.T) {
	t.Parallel()
	svc, root, _ := newRealFSSvc(t)

	summary, err := svc.CreateWithBody(context.Background(), "", "Fresh", "body\n")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got := readIDFromDisk(t, root, summary.Path); got != summary.ID {
		t.Errorf("file id %s, summary id %s", got, summary.ID)
	}
	data, _ := os.ReadFile(filepath.Join(root, summary.Path))
	want := "---\nid: " + summary.ID.String() + "\ntags: []\n---\n\n# Fresh\n\nbody\n"
	if string(data) != want {
		t.Errorf("file\n got: %q\nwant: %q", data, want)
	}
}

func TestService_CreateWithID(t *testing.T) {
	t.Parallel()
	svc, root, _ := newRealFSSvc(t)
	id := NewID()

	summary, err := svc.CreateWithID(context.Background(), "", "Chosen", "", "", id)
	if err != nil {
		t.Fatalf("CreateWithID: %v", err)
	}
	if summary.ID != id || readIDFromDisk(t, root, summary.Path) != id {
		t.Errorf("summary id %s, file id %s, want %s", summary.ID, readIDFromDisk(t, root, summary.Path), id)
	}

	_, err = svc.CreateWithID(context.Background(), "", "Another", "", "", id)
	if !errors.Is(err, ErrIDTaken) {
		t.Errorf("second CreateWithID = %v, want ErrIDTaken", err)
	}
	if fileExists(t, root, "another.md") {
		t.Errorf("a rejected create left a file behind")
	}
}

// Criterion 2: a move keeps the id.
func TestService_Move_KeepsID(t *testing.T) {
	t.Parallel()
	svc, root, _ := newRealFSSvc(t)
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	created, err := svc.Create(context.Background(), "", "Mover")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	moved, err := svc.Move(context.Background(), created.ID, "sub/moved.md")
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	if moved.ID != created.ID || readIDFromDisk(t, root, "sub/moved.md") != created.ID {
		t.Errorf("id changed across move: created %s, moved %s, file %s",
			created.ID, moved.ID, readIDFromDisk(t, root, "sub/moved.md"))
	}
}

// N5: the client cannot change or drop the id; the server's wins and the
// rewrite comes back in the response.
func TestService_Update_ForcesKnownID(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"replaced": "---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ntags: []\n---\n\nbody",
		"dropped":  "---\ntags: []\n---\n\nbody",
		"absent":   "# Heading\n\nbody",
		"empty":    "",
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			files := &fakeFileStore{statTime: time.Now()}
			svc := newSvc(t, files)
			note, err := svc.Update(context.Background(), ScratchpadID, content, "")
			if err != nil {
				t.Fatalf("Update: %v", err)
			}
			raw, found := markdown.ReadID(files.lastWriteData)
			if !found || raw != ScratchpadID.String() {
				t.Errorf("written id = %q, %v; want %s\n%q", raw, found, ScratchpadID, files.lastWriteData)
			}
			if note.Content != string(files.lastWriteData) {
				t.Errorf("response content %q differs from disk %q", note.Content, files.lastWriteData)
			}
		})
	}
}
