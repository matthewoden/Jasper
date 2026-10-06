package notes

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
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

func TestService_CreateWithID_RejectsTombstonedID(t *testing.T) {
	t.Parallel()
	svc, root, _ := newRealFSSvc(t)
	gone, err := svc.Create(context.Background(), "", "Gone")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := svc.Delete(context.Background(), gone.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	_, err = svc.CreateWithID(context.Background(), "", "Usurper", "", "", gone.ID)
	if !errors.Is(err, ErrIDTaken) {
		t.Errorf("CreateWithID with a deleted note's id = %v, want ErrIDTaken", err)
	}
	if fileExists(t, root, "usurper.md") {
		t.Errorf("a rejected create left a file behind")
	}
}

func TestService_CreateWithID_ConcurrentSameID(t *testing.T) {
	t.Parallel()
	svc, root, _ := newRealFSSvc(t)
	id := NewID()

	const n = 8
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = svc.CreateWithID(context.Background(), "", fmt.Sprintf("Racer %d", i), "", "", id)
		}()
	}
	wg.Wait()

	won := 0
	for _, err := range errs {
		switch {
		case err == nil:
			won++
		case !errors.Is(err, ErrIDTaken):
			t.Errorf("unexpected error: %v", err)
		}
	}
	if won != 1 {
		t.Errorf("%d creates succeeded, want 1", won)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	carrying := 0
	for _, e := range entries {
		if !e.IsDir() && readIDFromDisk(t, root, e.Name()) == id {
			carrying++
		}
	}
	if carrying != 1 {
		t.Errorf("%d files carry the id, want 1", carrying)
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

func TestService_Update_NormalizesCRLFFrontmatter(t *testing.T) {
	t.Parallel()
	files := &fakeFileStore{statTime: time.Now()}
	svc := newSvc(t, files)
	if _, err := svc.Update(context.Background(), ScratchpadID, "---\r\ntags: []\r\n---\r\n# T\r\n", ""); err != nil {
		t.Fatalf("Update: %v", err)
	}
	want := "---\nid: " + ScratchpadID.String() + "\ntags: []\n---\n# T\r\n"
	if got := string(files.lastWriteData); got != want {
		t.Errorf("written\n got: %q\nwant: %q", got, want)
	}
}

func TestService_Create_BroadcastsRefsChanged(t *testing.T) {
	t.Parallel()
	bc := &fakeBroadcaster{}
	idx := &refsDeltaIndex{stubIndex: newStubIndex(), delta: RefsDelta{Added: []string{"ado:workitem/1"}}}
	svc := newSvcWithBroadcaster(t, fsstore.NewStore(t.TempDir()), idx, bc)

	created, err := svc.CreateWithBody(context.Background(), "", "Linker", "[[ado:workitem/1]]\n")
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	for _, c := range bc.calls {
		if c.event == EventRefsChanged {
			p, _ := c.payload.(map[string]any)
			got = append(got, p)
		}
	}
	if len(got) != 1 {
		t.Fatalf("refs:changed broadcasts = %d among %+v, want 1", len(got), bc.calls)
	}
	if got[0]["source_id"] != created.ID.String() {
		t.Errorf("source_id = %v, want %s", got[0]["source_id"], created.ID)
	}
	if added, _ := got[0]["added"].([]string); len(added) != 1 || added[0] != "ado:workitem/1" {
		t.Errorf("added = %v", got[0]["added"])
	}
}

type refsDeltaIndex struct {
	*stubIndex
	delta RefsDelta
}

func (r *refsDeltaIndex) SyncBacklinks(context.Context, ID, string, []markdown.Ref, *Registry, []byte) (RefsDelta, error) {
	return r.delta, nil
}

// Criterion 6: a save that changes which targets a note references says so,
// after the index write, and a save that changes nothing stays quiet.
func TestService_Update_BroadcastsRefsChanged(t *testing.T) {
	t.Parallel()
	files := &fakeFileStore{statTime: time.Now()}
	idx := &fakeIndex{refsDelta: RefsDelta{Added: []string{"ado:workitem/1"}, Removed: nil}}
	bc := &fakeBroadcaster{}
	svc := newSvcWithBroadcaster(t, files, idx, bc)

	if _, err := svc.Update(context.Background(), ScratchpadID, "[[ado:workitem/1]]", ""); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	for _, c := range bc.calls {
		if c.event == EventRefsChanged {
			got, _ = c.payload.(map[string]any)
		}
	}
	if got == nil {
		t.Fatalf("no refs:changed among %+v", bc.calls)
	}
	if got["source_id"] != ScratchpadID.String() {
		t.Errorf("source_id = %v", got["source_id"])
	}
	if added, _ := got["added"].([]string); len(added) != 1 || added[0] != "ado:workitem/1" {
		t.Errorf("added = %v", got["added"])
	}
	if removed, _ := got["removed"].([]string); removed == nil || len(removed) != 0 {
		t.Errorf("removed = %#v, want an empty list on the wire", got["removed"])
	}

	bc.calls = nil
	idx.refsDelta = RefsDelta{}
	if _, err := svc.Update(context.Background(), ScratchpadID, "[[ado:workitem/1]]", ""); err != nil {
		t.Fatal(err)
	}
	for _, c := range bc.calls {
		if c.event == EventRefsChanged {
			t.Errorf("refs:changed broadcast with nothing changed")
		}
	}
}
