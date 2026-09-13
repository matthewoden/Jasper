package notes

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"path"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
)

// memFileStore is an in-memory FileStore that can be told to fail the Nth
// MoveFile, which is what the rollback path needs and what the shared
// fakeFileStore cannot express — its MoveFile is an unconditional no-op.
type memFileStore struct {
	files map[string][]byte
	dirs  map[string]bool

	moveCalls  int
	failMoveAt int // fail exactly the Nth MoveFile (1-indexed); 0 disables
}

func newMemFileStore() *memFileStore {
	return &memFileStore{files: map[string][]byte{}, dirs: map[string]bool{"": true}}
}

var errInjected = errors.New("injected failure")

func (m *memFileStore) Read(relPath string) ([]byte, error) {
	if data, ok := m.files[relPath]; ok {
		return data, nil
	}
	return nil, fs.ErrNotExist
}

func (m *memFileStore) WriteAtomic(relPath string, data []byte) error {
	cp := make([]byte, len(data))
	copy(cp, data)
	m.files[relPath] = cp
	return nil
}

func (m *memFileStore) Stat(relPath string) (time.Time, error) {
	if _, ok := m.files[relPath]; ok {
		return time.Unix(0, 0), nil
	}
	if m.dirs[relPath] {
		return time.Unix(0, 0), nil
	}
	return time.Time{}, fs.ErrNotExist
}

func (m *memFileStore) CreateFile(relPath string) error {
	m.files[relPath] = nil
	return nil
}

func (m *memFileStore) DeleteFile(relPath string) error {
	delete(m.files, relPath)
	return nil
}

func (m *memFileStore) MoveFile(oldRelPath, newRelPath string) error {
	m.moveCalls++
	// Exactly the Nth call, so the undo's own moves still succeed — otherwise
	// the fake, not the code, is what leaves the vault inconsistent.
	if m.failMoveAt > 0 && m.moveCalls == m.failMoveAt {
		return errInjected
	}
	data, ok := m.files[oldRelPath]
	if !ok {
		return fs.ErrNotExist
	}
	delete(m.files, oldRelPath)
	m.files[newRelPath] = data
	return nil
}

func (m *memFileStore) CreateDir(relPath string) error {
	m.dirs[relPath] = true
	return nil
}

func (m *memFileStore) DeleteDir(relPath string, _ bool) error {
	delete(m.dirs, relPath)
	return nil
}

func (m *memFileStore) MoveDir(oldRelPath, newRelPath string) error {
	delete(m.dirs, oldRelPath)
	m.dirs[newRelPath] = true
	return nil
}

func (m *memFileStore) TrashFile(relPath string) (string, error) {
	delete(m.files, relPath)
	return "trashed", nil
}

func (m *memFileStore) TrashDir(relPath string) (string, error) {
	delete(m.dirs, relPath)
	return "trashed", nil
}

func (m *memFileStore) paths() []string {
	out := make([]string, 0, len(m.files))
	for p := range m.files {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

func newRelocateService(store *memFileStore, siblings []NoteSummary) *Service {
	return NewService(
		store,
		&fakeIndex{listResult: siblings},
		nil,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
}

func TestRelocateAttachmentsUndoesEveryMoveOnFailure(t *testing.T) {
	t.Parallel()

	store := newMemFileStore()
	store.dirs["sub"] = true
	store.dirs["sub/attachments"] = true
	body := "# n\n\n![a](attachments/a.png)\n![b](attachments/b.png)\n"
	store.files["n.md"] = []byte(body)
	store.files["sub/attachments/a.png"] = []byte("A")
	store.files["sub/attachments/b.png"] = []byte("B")

	// The .md rename is Move's business, so the note already sits at its
	// destination by the time relocation runs: one successful attachment move,
	// then a failure on the second.
	store.failMoveAt = 2

	svc := newRelocateService(store, nil)
	rewritten, err := svc.relocateAttachments(
		context.Background(), uuid.New(), []byte(body), "sub/n.md", "n.md",
	)

	if err == nil {
		t.Fatal("expected an error when the second attachment move fails")
	}
	if rewritten != nil {
		t.Errorf("expected nil content on failure, got %q", rewritten)
	}

	for _, want := range []string{"sub/attachments/a.png", "sub/attachments/b.png"} {
		if _, ok := store.files[want]; !ok {
			t.Errorf("%s should have been restored by the undo, files = %v", want, store.paths())
		}
	}
	for _, unwanted := range []string{"attachments/a.png", "attachments/b.png"} {
		if _, ok := store.files[unwanted]; ok {
			t.Errorf("%s should not survive the undo, files = %v", unwanted, store.paths())
		}
	}
}

func TestRelocateAttachmentsCopiesWhenASiblingStillReferencesIt(t *testing.T) {
	t.Parallel()

	store := newMemFileStore()
	store.dirs["sub"] = true
	store.dirs["sub/attachments"] = true
	moverBody := "# mover\n\n![s](attachments/s.png)\n"
	store.files["mover.md"] = []byte(moverBody)
	store.files["sub/stayer.md"] = []byte("# stayer\n\n![s](attachments/s.png)\n")
	store.files["sub/attachments/s.png"] = []byte("S")

	stayerID := uuid.New()
	svc := newRelocateService(store, []NoteSummary{{ID: stayerID, Path: "sub/stayer.md"}})

	rewritten, err := svc.relocateAttachments(
		context.Background(), uuid.New(), []byte(moverBody), "sub/mover.md", "mover.md",
	)
	if err != nil {
		t.Fatalf("relocateAttachments: %v", err)
	}
	if rewritten != nil {
		t.Errorf("a copy needs no rewrite, got %q", rewritten)
	}

	if _, ok := store.files["sub/attachments/s.png"]; !ok {
		t.Error("the sibling's copy must stay put")
	}
	if _, ok := store.files["attachments/s.png"]; !ok {
		t.Error("the mover needs its own copy at the destination")
	}
}

func TestRelocateAttachmentsMovesWhenTheSiblingNoLongerReferencesIt(t *testing.T) {
	t.Parallel()

	store := newMemFileStore()
	store.dirs["sub"] = true
	store.dirs["sub/attachments"] = true
	moverBody := "# mover\n\n![s](attachments/s.png)\n"
	store.files["mover.md"] = []byte(moverBody)
	store.files["sub/stayer.md"] = []byte("# stayer\n\nno attachments here\n")
	store.files["sub/attachments/s.png"] = []byte("S")

	svc := newRelocateService(store, []NoteSummary{{ID: uuid.New(), Path: "sub/stayer.md"}})

	if _, err := svc.relocateAttachments(
		context.Background(), uuid.New(), []byte(moverBody), "sub/mover.md", "mover.md",
	); err != nil {
		t.Fatalf("relocateAttachments: %v", err)
	}

	if _, ok := store.files["sub/attachments/s.png"]; ok {
		t.Error("nothing references it in the source folder any more; it should have moved")
	}
	if _, ok := store.files["attachments/s.png"]; !ok {
		t.Error("expected the file at the destination")
	}
}

func TestRelocateAttachmentsSkipsAlreadyDanglingReference(t *testing.T) {
	t.Parallel()

	store := newMemFileStore()
	store.dirs["sub"] = true
	body := "# n\n\n![gone](attachments/gone.png)\n"
	store.files["n.md"] = []byte(body)

	svc := newRelocateService(store, nil)
	rewritten, err := svc.relocateAttachments(
		context.Background(), uuid.New(), []byte(body), "sub/n.md", "n.md",
	)
	if err != nil {
		t.Fatalf("a reference that was already broken must not fail the move: %v", err)
	}
	if rewritten != nil {
		t.Errorf("expected no rewrite, got %q", rewritten)
	}
}

func TestRelocateAttachmentsIsANoopForAnInPlaceRename(t *testing.T) {
	t.Parallel()

	store := newMemFileStore()
	store.dirs["sub"] = true
	store.dirs["sub/attachments"] = true
	body := "# n\n\n![a](attachments/a.png)\n"
	store.files["sub/after.md"] = []byte(body)
	store.files["sub/attachments/a.png"] = []byte("A")

	svc := newRelocateService(store, nil)
	if _, err := svc.relocateAttachments(
		context.Background(), uuid.New(), []byte(body), "sub/before.md", "sub/after.md",
	); err != nil {
		t.Fatalf("relocateAttachments: %v", err)
	}

	if store.moveCalls != 0 {
		t.Errorf("an in-place rename must touch no attachment, got %d MoveFile calls", store.moveCalls)
	}
}

func TestFolderOfAndJoinRel(t *testing.T) {
	t.Parallel()

	if got := folderOf("note.md"); got != "" {
		t.Errorf(`folderOf("note.md") = %q, want ""`, got)
	}
	if got := folderOf("sub/note.md"); got != "sub" {
		t.Errorf(`folderOf("sub/note.md") = %q, want "sub"`, got)
	}
	if got := joinRel("", "attachments/a.png"); got != "attachments/a.png" {
		t.Errorf(`joinRel("", ...) = %q`, got)
	}
	if got := joinRel("sub", "attachments/a.png"); got != "sub/attachments/a.png" {
		t.Errorf(`joinRel("sub", ...) = %q`, got)
	}
	// path.Dir of a bare "attachments/a.png" is "attachments"; of a bare file
	// it is ".", which must collapse to the folder itself.
	if got := joinRel("sub", path.Dir("a.png")); got != "sub" {
		t.Errorf(`joinRel("sub", ".") = %q, want "sub"`, got)
	}
}
