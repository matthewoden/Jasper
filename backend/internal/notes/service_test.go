package notes

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
)

// fakeFileStore is the in-test impl of FileStore. Only the fields a given
// test needs are populated; defaults zero out cleanly.
type fakeFileStore struct {
	readBytes     []byte
	readErr       error
	statTime      time.Time
	statErr       error
	writeCalls    int
	lastWritePath string
	lastWriteData []byte
	writeErr      error
}

func (f *fakeFileStore) Read(_ string) ([]byte, error) {
	return f.readBytes, f.readErr
}

func (f *fakeFileStore) WriteAtomic(relPath string, data []byte) error {
	f.writeCalls++
	f.lastWritePath = relPath
	// Copy into a new slice so callers can't tamper through the buffer.
	cp := make([]byte, len(data))
	copy(cp, data)
	f.lastWriteData = cp
	return f.writeErr
}

func (f *fakeFileStore) Stat(_ string) (time.Time, error) {
	return f.statTime, f.statErr
}

func newSvc(t *testing.T, files FileStore) *Service {
	t.Helper()
	// Discard logs — tests assert on returned values, not log output.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewService(files, nil, logger)
}

// Test 1: known UUID returns a populated Note.
func TestService_Get_Known(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	files := &fakeFileStore{
		readBytes: []byte("hello"),
		statTime:  now,
	}
	svc := newSvc(t, files)

	note, err := svc.Get(context.Background(), ScratchpadUUID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if note.ID != ScratchpadUUID {
		t.Errorf("ID: got %v, want %v", note.ID, ScratchpadUUID)
	}
	if note.Path != ScratchpadRelPath {
		t.Errorf("Path: got %q, want %q", note.Path, ScratchpadRelPath)
	}
	if note.Content != "hello" {
		t.Errorf("Content: got %q, want %q", note.Content, "hello")
	}
	if !note.UpdatedAt.Equal(now) {
		t.Errorf("UpdatedAt: got %v, want %v", note.UpdatedAt, now)
	}
}

// Test 2: unknown UUID returns ErrNotFound.
func TestService_Get_Unknown(t *testing.T) {
	files := &fakeFileStore{}
	svc := newSvc(t, files)

	_, err := svc.Get(context.Background(), uuid.New())
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// Test 2b: known UUID but file missing on disk returns ErrNotFound.
// (Plan 04's main.go is responsible for seeding scratchpad.md; if it
// did not, the API layer's 404 is correct rather than a 500.)
func TestService_Get_MissingFile(t *testing.T) {
	files := &fakeFileStore{
		readErr: fs.ErrNotExist,
	}
	svc := newSvc(t, files)

	_, err := svc.Get(context.Background(), ScratchpadUUID)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound on missing file, got %v", err)
	}
}

// Test 3: known UUID writes via WriteAtomic exactly once with the right
// path + bytes.
func TestService_Update_Known(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	files := &fakeFileStore{statTime: now}
	svc := newSvc(t, files)

	note, err := svc.Update(context.Background(), ScratchpadUUID, "new content")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if files.writeCalls != 1 {
		t.Errorf("writeCalls: got %d, want 1", files.writeCalls)
	}
	if files.lastWritePath != ScratchpadRelPath {
		t.Errorf("lastWritePath: got %q, want %q", files.lastWritePath, ScratchpadRelPath)
	}
	if string(files.lastWriteData) != "new content" {
		t.Errorf("lastWriteData: got %q, want %q", files.lastWriteData, "new content")
	}
	if !note.UpdatedAt.Equal(now) {
		t.Errorf("UpdatedAt: got %v, want %v", note.UpdatedAt, now)
	}
}

// Test 4: unknown UUID never calls WriteAtomic.
func TestService_Update_Unknown(t *testing.T) {
	files := &fakeFileStore{}
	svc := newSvc(t, files)

	_, err := svc.Update(context.Background(), uuid.New(), "ignored")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if files.writeCalls != 0 {
		t.Errorf("WriteAtomic was called for unknown UUID: %d times", files.writeCalls)
	}
}

// Test 5: empty content is a legal write (Phase 1 textarea can be empty).
func TestService_Update_EmptyContent(t *testing.T) {
	files := &fakeFileStore{statTime: time.Now()}
	svc := newSvc(t, files)

	if _, err := svc.Update(context.Background(), ScratchpadUUID, ""); err != nil {
		t.Fatalf("expected empty content to be legal, got %v", err)
	}
	if files.writeCalls != 1 {
		t.Errorf("writeCalls: got %d, want 1", files.writeCalls)
	}
	if len(files.lastWriteData) != 0 {
		t.Errorf("lastWriteData: got %q, want empty", files.lastWriteData)
	}
}

// Test 6: WriteAtomic error propagates wrapped (errors.Is unwraps).
func TestService_Update_WriteErrorPropagates(t *testing.T) {
	sentinel := errors.New("disk full")
	files := &fakeFileStore{writeErr: sentinel}
	svc := newSvc(t, files)

	_, err := svc.Update(context.Background(), ScratchpadUUID, "content")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected wrapped sentinel, got %v", err)
	}
}

// Sanity: registry.Lookup of the seeded UUID returns the expected path.
func TestRegistry_LookupScratchpad(t *testing.T) {
	r := NewRegistry()
	relPath, ok := r.Lookup(ScratchpadUUID)
	if !ok {
		t.Fatalf("ScratchpadUUID not in registry")
	}
	if relPath != ScratchpadRelPath {
		t.Errorf("got %q, want %q", relPath, ScratchpadRelPath)
	}
}

// Sanity: ScratchpadWelcome contains the verbatim UI-SPEC content (key
// phrases). Full byte-for-byte comparison would be brittle if the file
// is intentionally tweaked later; we test the load-bearing pieces.
func TestScratchpadWelcome_HasRequiredContent(t *testing.T) {
	for _, want := range []string{
		"# Welcome to Jasper",
		"This is your scratchpad",
		"⌘S",
		"`~/.jasper/notes/scratchpad.md`",
	} {
		if !contains(ScratchpadWelcome, want) {
			t.Errorf("ScratchpadWelcome missing %q", want)
		}
	}
	// Trailing newline at end of file (UI-SPEC).
	if len(ScratchpadWelcome) == 0 || ScratchpadWelcome[len(ScratchpadWelcome)-1] != '\n' {
		t.Errorf("ScratchpadWelcome missing trailing newline")
	}
}

func contains(haystack, needle string) bool {
	if len(needle) > len(haystack) {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
