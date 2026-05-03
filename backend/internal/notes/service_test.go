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
	// observedSeq, when non-nil, is appended with "write" on each
	// WriteAtomic call. Paired with fakeIndex.upsertObservedSeq (the
	// SAME slice pointer) it lets tests assert file-FIRST ordering.
	observedSeq *[]string
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
	if f.observedSeq != nil {
		*f.observedSeq = append(*f.observedSeq, "write")
	}
	return f.writeErr
}

func (f *fakeFileStore) Stat(_ string) (time.Time, error) {
	return f.statTime, f.statErr
}

// fakeIndex is the in-test Index spy. Captures Upsert/Delete/List
// calls so tests can assert ordering (file-FIRST), call counts, and
// the NoteRecord shape Service constructs from the on-disk metadata.
type fakeIndex struct {
	upsertCalls      int
	lastUpsertRecord NoteRecord
	upsertErr        error
	// observedSeq, when non-nil, is appended with "upsert" on each
	// Upsert call. Paired with fakeFileStore.observedSeq (the SAME
	// slice pointer) it lets tests assert file-FIRST ordering.
	observedSeq  *[]string
	deleteCalls  int
	lastDeleteID uuid.UUID
	listResult   []NoteSummary
}

func (f *fakeIndex) Upsert(_ context.Context, rec NoteRecord) error {
	f.upsertCalls++
	f.lastUpsertRecord = rec
	if f.observedSeq != nil {
		*f.observedSeq = append(*f.observedSeq, "upsert")
	}
	return f.upsertErr
}

func (f *fakeIndex) Delete(_ context.Context, id uuid.UUID) error {
	f.deleteCalls++
	f.lastDeleteID = id
	return nil
}

func (f *fakeIndex) List(_ context.Context) ([]NoteSummary, error) {
	return f.listResult, nil
}

func newSvc(t *testing.T, files FileStore) *Service {
	t.Helper()
	// Discard logs — tests assert on returned values, not log output.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewService(files, nil, logger)
}

// newSvcWithIndex constructs a Service with a real fakeIndex for tests
// that assert on Index.Upsert call shape / ordering.
func newSvcWithIndex(t *testing.T, files FileStore, idx Index) *Service {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewService(files, idx, logger)
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

// ----------------------------------------------------------------------
// Plan 02-04a Task 2: Index.Upsert wiring tests
// ----------------------------------------------------------------------

// TestService_Update_CallsIndexUpsertAfterWrite asserts the file-FIRST
// contract: Update calls WriteAtomic AND THEN Index.Upsert with a
// NoteRecord whose path/mtime/size match the on-disk metadata.
func TestService_Update_CallsIndexUpsertAfterWrite(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	seq := make([]string, 0, 2)
	files := &fakeFileStore{statTime: now, observedSeq: &seq}
	idx := &fakeIndex{observedSeq: &seq}
	svc := newSvcWithIndex(t, files, idx)

	const content = "new content"
	note, err := svc.Update(context.Background(), ScratchpadUUID, content)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if files.writeCalls != 1 {
		t.Errorf("writeCalls: got %d, want 1", files.writeCalls)
	}
	if idx.upsertCalls != 1 {
		t.Fatalf("upsertCalls: got %d, want 1", idx.upsertCalls)
	}

	// File FIRST, Index SECOND — locked by ARCHITECTURE §11.1.
	if len(seq) != 2 || seq[0] != "write" || seq[1] != "upsert" {
		t.Fatalf("call sequence: got %v, want [write upsert]", seq)
	}

	// NoteRecord shape: ID + Path match the registry; MTimeUnix + size
	// reflect the file metadata; Checksum stays empty (Phase 7 only).
	rec := idx.lastUpsertRecord
	if rec.ID != ScratchpadUUID {
		t.Errorf("rec.ID: got %v, want %v", rec.ID, ScratchpadUUID)
	}
	if rec.Path != ScratchpadRelPath {
		t.Errorf("rec.Path: got %q, want %q", rec.Path, ScratchpadRelPath)
	}
	if rec.MTimeUnix != now.Unix() {
		t.Errorf("rec.MTimeUnix: got %d, want %d", rec.MTimeUnix, now.Unix())
	}
	if rec.SizeBytes != int64(len(content)) {
		t.Errorf("rec.SizeBytes: got %d, want %d", rec.SizeBytes, len(content))
	}
	if rec.Checksum != "" {
		t.Errorf("rec.Checksum: got %q, want empty (Phase 7 only)", rec.Checksum)
	}
	if rec.UpdatedAtUnix != now.Unix() {
		t.Errorf("rec.UpdatedAtUnix: got %d, want %d", rec.UpdatedAtUnix, now.Unix())
	}

	// Returned Note is unaffected by the index call.
	if !note.UpdatedAt.Equal(now) {
		t.Errorf("note.UpdatedAt: got %v, want %v", note.UpdatedAt, now)
	}
}

// TestService_Update_CaseCollision_PropagatesError: if Index.Upsert
// returns ErrCaseCollision the error propagates wrapped to the caller
// (the API layer maps to 409). The file IS still written (file-FIRST
// contract — the next Reconcile re-attempts Upsert).
func TestService_Update_CaseCollision_PropagatesError(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	files := &fakeFileStore{statTime: now}
	idx := &fakeIndex{upsertErr: ErrCaseCollision}
	svc := newSvcWithIndex(t, files, idx)

	_, err := svc.Update(context.Background(), ScratchpadUUID, "content")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !errors.Is(err, ErrCaseCollision) {
		t.Fatalf("expected wrapped ErrCaseCollision, got %v", err)
	}
	// File-FIRST: WriteAtomic ran exactly once even though Upsert failed.
	if files.writeCalls != 1 {
		t.Errorf("writeCalls: got %d, want 1 (file-FIRST contract)", files.writeCalls)
	}
}

// TestService_Update_OtherIndexError_DoesNotFailSave: a transient index
// error (not ErrCaseCollision) is logged but does NOT propagate. The
// file is on disk, the user's content is durable, and the next
// Reconcile heals the index. File-FIRST contract per DATA-01.
func TestService_Update_OtherIndexError_DoesNotFailSave(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	transient := errors.New("transient sqlite busy")
	files := &fakeFileStore{statTime: now}
	idx := &fakeIndex{upsertErr: transient}
	svc := newSvcWithIndex(t, files, idx)

	note, err := svc.Update(context.Background(), ScratchpadUUID, "content")
	if err != nil {
		t.Fatalf("file-FIRST contract violated: transient index error must not fail save, got %v", err)
	}
	if !note.UpdatedAt.Equal(now) {
		t.Errorf("note.UpdatedAt: got %v, want %v", note.UpdatedAt, now)
	}
	if files.writeCalls != 1 {
		t.Errorf("writeCalls: got %d, want 1", files.writeCalls)
	}
	if idx.upsertCalls != 1 {
		t.Errorf("upsertCalls: got %d, want 1", idx.upsertCalls)
	}
}

// TestService_NewService_NilIndex_FallsBackToNopIndex: passing nil for
// index is allowed (Phase 1 backwards compat); Service substitutes a
// no-op so Update succeeds without panicking.
func TestService_NewService_NilIndex_FallsBackToNopIndex(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	files := &fakeFileStore{statTime: now}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := NewService(files, nil, logger) // nil Index

	// Should not panic; should not error.
	if _, err := svc.Update(context.Background(), ScratchpadUUID, "content"); err != nil {
		t.Fatalf("nil Index path failed: %v", err)
	}
	if files.writeCalls != 1 {
		t.Errorf("writeCalls: got %d, want 1", files.writeCalls)
	}
}
