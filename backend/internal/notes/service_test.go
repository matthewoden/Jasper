package notes

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/markdown"
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

// Phase 3 Plan 03-03 — extended notes.FileStore port methods. The
// Phase 1+2 tests in this file do not exercise mutation primitives;
// the new Plan 03-03 tests use a real fsstore.Store via newRealFSSvc.
// Default no-ops keep the port satisfied at compile time.
func (f *fakeFileStore) CreateFile(_ string) error        { return nil }
func (f *fakeFileStore) DeleteFile(_ string) error        { return nil }
func (f *fakeFileStore) MoveFile(_, _ string) error       { return nil }
func (f *fakeFileStore) CreateDir(_ string) error         { return nil }
func (f *fakeFileStore) DeleteDir(_ string, _ bool) error { return nil }
func (f *fakeFileStore) MoveDir(_, _ string) error        { return nil }

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

// Phase 3 Plan 03-03 — extended port methods. Defaults that suit the
// Phase 1+2 tests (which never call them); the Plan 03-03 tests
// override these via stubIndex below where richer behavior is needed.
func (f *fakeIndex) LookupByPath(_ context.Context, _ string) (NoteRecord, error) {
	return NoteRecord{}, ErrNotFound
}
func (f *fakeIndex) MovePathPrefix(_ context.Context, _, _ string) (int, error) { return 0, nil }
func (f *fakeIndex) DeleteByPathPrefix(_ context.Context, _ string) (int, error) {
	return 0, nil
}

// Phase 6 Plan 06-05 — nopIndex no-ops for fakeIndex.
func (f *fakeIndex) SyncTags(_ context.Context, _ uuid.UUID, _ []string) error { return nil }

func (f *fakeIndex) SyncBacklinks(_ context.Context, _ uuid.UUID, _ string,
	_ []markdown.WikiLinkRef, _ *Registry, _ []byte,
) error {
	return nil
}

// Phase 6 Plan 06-05 Task 3 — cross-vault rewrite stubs for fakeIndex.
func (f *fakeIndex) NotesByTag(_ context.Context, _ string) ([]NoteSummary, error) {
	return []NoteSummary{}, nil
}

func (f *fakeIndex) RenameTag(_ context.Context, _, _ string) ([]uuid.UUID, error) {
	return nil, nil
}

func (f *fakeIndex) DeleteTag(_ context.Context, _ string) ([]uuid.UUID, error) {
	return nil, nil
}

func (f *fakeIndex) SourcesByBacklinkTitle(_ context.Context, _ string) ([]NoteSummary, error) {
	return []NoteSummary{}, nil
}

func (f *fakeIndex) UpdateBacklinksTargetTitle(_ context.Context, _, _ string, _ *uuid.UUID) error {
	return nil
}

// --------------------------------------------------------------------------
// Plan 04-04 Task 1: fakeBroadcaster + 5 new If-Match / broadcast tests
// --------------------------------------------------------------------------

// broadcastCall records a single Broadcast invocation for test assertions.
type broadcastCall struct {
	event           string
	payload         any
	originSessionID string
}

// fakeBroadcaster is the in-test Broadcaster spy. Captures all Broadcast
// calls. observedSeq, when non-nil, appends "broadcast" to support
// file→upsert→broadcast ordering assertions (same pattern as fakeIndex).
type fakeBroadcaster struct {
	calls       []broadcastCall
	observedSeq *[]string
}

func (f *fakeBroadcaster) Broadcast(event string, payload any, sid string) {
	f.calls = append(f.calls, broadcastCall{event, payload, sid})
	if f.observedSeq != nil {
		*f.observedSeq = append(*f.observedSeq, "broadcast")
	}
}

// newSvcWithBroadcaster constructs a Service with index + broadcaster.
func newSvcWithBroadcaster(t *testing.T, files FileStore, idx Index, bc Broadcaster) *Service {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewService(files, idx, bc, logger)
}

func newSvc(t *testing.T, files FileStore) *Service {
	t.Helper()
	// Discard logs — tests assert on returned values, not log output.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewService(files, nil, nil, logger)
}

// newSvcWithIndex constructs a Service with a real fakeIndex for tests
// that assert on Index.Upsert call shape / ordering.
func newSvcWithIndex(t *testing.T, files FileStore, idx Index) *Service {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewService(files, idx, nil, logger)
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
// path + bytes. Content that already has a frontmatter block is written
// verbatim (D-10 auto-restore only triggers when frontmatter is absent).
func TestService_Update_Known(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	files := &fakeFileStore{statTime: now}
	svc := newSvc(t, files)

	const content = "---\ntags: []\n---\n\nnew content"
	note, err := svc.Update(context.Background(), ScratchpadUUID, content, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if files.writeCalls != 1 {
		t.Errorf("writeCalls: got %d, want 1", files.writeCalls)
	}
	if files.lastWritePath != ScratchpadRelPath {
		t.Errorf("lastWritePath: got %q, want %q", files.lastWritePath, ScratchpadRelPath)
	}
	if string(files.lastWriteData) != content {
		t.Errorf("lastWriteData: got %q, want %q", files.lastWriteData, content)
	}
	if !note.UpdatedAt.Equal(now) {
		t.Errorf("UpdatedAt: got %v, want %v", note.UpdatedAt, now)
	}
}

// Test 4: unknown UUID never calls WriteAtomic.
func TestService_Update_Unknown(t *testing.T) {
	files := &fakeFileStore{}
	svc := newSvc(t, files)

	_, err := svc.Update(context.Background(), uuid.New(), "ignored", "")
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

	if _, err := svc.Update(context.Background(), ScratchpadUUID, "", ""); err != nil {
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

	_, err := svc.Update(context.Background(), ScratchpadUUID, "content", "")
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

	// Content with frontmatter so D-10 auto-restore does not trigger and
	// the written bytes are exactly what we supply (no prefix injection).
	const content = "---\ntags: []\n---\n\nnew content"
	note, err := svc.Update(context.Background(), ScratchpadUUID, content, "")
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

	_, err := svc.Update(context.Background(), ScratchpadUUID, "content", "")
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

	note, err := svc.Update(context.Background(), ScratchpadUUID, "content", "")
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
	svc := NewService(files, nil, nil, logger) // nil Index, nil Broadcaster

	// Should not panic; should not error.
	if _, err := svc.Update(context.Background(), ScratchpadUUID, "content", ""); err != nil {
		t.Fatalf("nil Index path failed: %v", err)
	}
	if files.writeCalls != 1 {
		t.Errorf("writeCalls: got %d, want 1", files.writeCalls)
	}
}

// ----------------------------------------------------------------------
// Plan 03-03 Task 2: Service mutations + Registry dynamic ops tests
// ----------------------------------------------------------------------

// stubIndex is a richer in-memory Index spy for the Phase 3 mutation
// tests. Maintains a path → NoteRecord map plus per-method failure
// injection. Concurrent-safe via a single RWMutex (the Service does
// NOT issue concurrent calls in any production path, but the test
// harness builds them up sequentially under the same lock to keep the
// race detector quiet).
type stubIndex struct {
	mu sync.RWMutex

	byPath map[string]NoteRecord
	byID   map[uuid.UUID]NoteRecord

	// Failure injection
	upsertErr             error
	deleteErr             error
	lookupErr             error
	movePathPrefixErr     error
	deleteByPathPrefixErr error
}

func newStubIndex() *stubIndex {
	return &stubIndex{
		byPath: make(map[string]NoteRecord),
		byID:   make(map[uuid.UUID]NoteRecord),
	}
}

func (s *stubIndex) Upsert(_ context.Context, rec NoteRecord) error {
	if s.upsertErr != nil {
		return s.upsertErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Detect case-insensitive path collisions with a different id (DATA-12).
	if existing, ok := s.byPath[rec.Path]; ok && existing.ID != rec.ID {
		return ErrCaseCollision
	}
	// Replace any old path mapping for this id.
	if old, ok := s.byID[rec.ID]; ok && old.Path != rec.Path {
		delete(s.byPath, old.Path)
	}
	s.byPath[rec.Path] = rec
	s.byID[rec.ID] = rec
	return nil
}

func (s *stubIndex) Delete(_ context.Context, id uuid.UUID) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if rec, ok := s.byID[id]; ok {
		delete(s.byPath, rec.Path)
		delete(s.byID, id)
	}
	return nil
}

func (s *stubIndex) List(_ context.Context) ([]NoteSummary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]NoteSummary, 0, len(s.byID))
	for _, rec := range s.byID {
		out = append(out, NoteSummary{
			ID:        rec.ID,
			Path:      rec.Path,
			Title:     rec.Title,
			UpdatedAt: time.Unix(rec.MTimeUnix, 0).UTC(),
		})
	}
	return out, nil
}

func (s *stubIndex) LookupByPath(_ context.Context, p string) (NoteRecord, error) {
	if s.lookupErr != nil {
		return NoteRecord{}, s.lookupErr
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if rec, ok := s.byPath[p]; ok {
		return rec, nil
	}
	return NoteRecord{}, ErrNotFound
}

func (s *stubIndex) MovePathPrefix(_ context.Context, oldPrefix, newPrefix string) (int, error) {
	if s.movePathPrefixErr != nil {
		return 0, s.movePathPrefixErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	// Collision pre-check: any existing row under newPrefix that is not
	// already under oldPrefix is a foreign collision.
	for p := range s.byPath {
		if strings.HasPrefix(p, newPrefix) && !strings.HasPrefix(p, oldPrefix) {
			return 0, ErrCaseCollision
		}
	}

	// Collect rows to move.
	moves := []NoteRecord{}
	for p, rec := range s.byPath {
		if strings.HasPrefix(p, oldPrefix) {
			moves = append(moves, rec)
		}
	}
	for _, rec := range moves {
		newPath := newPrefix + strings.TrimPrefix(rec.Path, oldPrefix)
		delete(s.byPath, rec.Path)
		rec.Path = newPath
		s.byPath[newPath] = rec
		s.byID[rec.ID] = rec
	}
	return len(moves), nil
}

func (s *stubIndex) DeleteByPathPrefix(_ context.Context, prefix string) (int, error) {
	if s.deleteByPathPrefixErr != nil {
		return 0, s.deleteByPathPrefixErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	matched := []NoteRecord{}
	for p, rec := range s.byPath {
		if prefix == "" || p == prefix || strings.HasPrefix(p, prefix+"/") {
			matched = append(matched, rec)
		}
	}
	for _, rec := range matched {
		delete(s.byPath, rec.Path)
		delete(s.byID, rec.ID)
	}
	return len(matched), nil
}

// Phase 6 Plan 06-05 — stubIndex no-ops for tag + backlink sync.
func (s *stubIndex) SyncTags(_ context.Context, _ uuid.UUID, _ []string) error { return nil }

func (s *stubIndex) SyncBacklinks(_ context.Context, _ uuid.UUID, _ string,
	_ []markdown.WikiLinkRef, _ *Registry, _ []byte,
) error {
	return nil
}

// Phase 6 Plan 06-05 Task 3 — cross-vault rewrite stubs for stubIndex.
func (s *stubIndex) NotesByTag(_ context.Context, _ string) ([]NoteSummary, error) {
	return []NoteSummary{}, nil
}

func (s *stubIndex) RenameTag(_ context.Context, _, _ string) ([]uuid.UUID, error) {
	return nil, nil
}

func (s *stubIndex) DeleteTag(_ context.Context, _ string) ([]uuid.UUID, error) {
	return nil, nil
}

func (s *stubIndex) SourcesByBacklinkTitle(_ context.Context, _ string) ([]NoteSummary, error) {
	return []NoteSummary{}, nil
}

func (s *stubIndex) UpdateBacklinksTargetTitle(_ context.Context, _, _ string, _ *uuid.UUID) error {
	return nil
}

// recByID returns the in-memory record for assertions. Test-only.
func (s *stubIndex) recByID(id uuid.UUID) (NoteRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, ok := s.byID[id]
	return rec, ok
}

func (s *stubIndex) recByPath(p string) (NoteRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, ok := s.byPath[p]
	return rec, ok
}

func (s *stubIndex) count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.byID)
}

// newRealFSSvc constructs a Service backed by a real fsstore.Store
// rooted at a freshly-allocated tempdir + a stubIndex for SQLite-like
// behavior. Returns the service, the store root, and the stub for
// assertions.
func newRealFSSvc(t *testing.T) (*Service, string, *stubIndex) {
	t.Helper()
	root := t.TempDir()
	store := fsstore.NewStore(root)
	idx := newStubIndex()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := NewService(store, idx, nil, logger)
	return svc, root, idx
}

// fileExists reports whether a file (not a dir) exists at root/relPath.
func fileExists(t *testing.T, root, relPath string) bool {
	t.Helper()
	info, err := os.Stat(filepath.Join(root, relPath))
	if err != nil {
		return false
	}
	return !info.IsDir()
}

// dirExists reports whether a directory exists at root/relPath.
func dirExists(t *testing.T, root, relPath string) bool {
	t.Helper()
	info, err := os.Stat(filepath.Join(root, relPath))
	if err != nil {
		return false
	}
	return info.IsDir()
}

// --- Service.Create ---

func TestService_Create_HappyPath(t *testing.T) {
	t.Parallel()
	svc, root, idx := newRealFSSvc(t)

	summary, err := svc.Create(context.Background(), "", "alpha")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if summary.Path != "alpha.md" {
		t.Errorf("Path: got %q, want %q", summary.Path, "alpha.md")
	}
	if !fileExists(t, root, "alpha.md") {
		t.Errorf("file not created on disk")
	}
	if _, ok := idx.recByID(summary.ID); !ok {
		t.Errorf("index has no row for created note")
	}
	if _, ok := svc.registry.Lookup(summary.ID); !ok {
		t.Errorf("registry has no entry for created note id")
	}
}

func TestService_Create_InFolder(t *testing.T) {
	t.Parallel()
	svc, root, idx := newRealFSSvc(t)

	// Need to mkdir parent first per single-level mkdir policy
	if _, err := svc.CreateFolder(context.Background(), "", "projects"); err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	summary, err := svc.Create(context.Background(), "projects", "alpha")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if summary.Path != "projects/alpha.md" {
		t.Errorf("Path: got %q, want %q", summary.Path, "projects/alpha.md")
	}
	if !fileExists(t, root, "projects/alpha.md") {
		t.Errorf("file not created on disk at projects/alpha.md")
	}
	if _, ok := idx.recByPath("projects/alpha.md"); !ok {
		t.Errorf("index missing row for projects/alpha.md")
	}
}

func TestService_Create_RejectsTitleWithSlash(t *testing.T) {
	t.Parallel()
	svc, root, idx := newRealFSSvc(t)

	_, err := svc.Create(context.Background(), "", "a/b")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if fileExists(t, root, "a/b.md") || fileExists(t, root, "a") {
		t.Errorf("file created despite invalid title")
	}
	if idx.count() != 0 {
		t.Errorf("index touched: %d rows", idx.count())
	}
}

func TestService_Create_RejectsTitleWithMdSuffix(t *testing.T) {
	t.Parallel()
	svc, _, _ := newRealFSSvc(t)

	_, err := svc.Create(context.Background(), "", "x.md")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
}

func TestService_Create_RejectsBackslash(t *testing.T) {
	t.Parallel()
	svc, _, _ := newRealFSSvc(t)
	_, err := svc.Create(context.Background(), "", "a\\b")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
}

func TestService_Create_RejectsControlChars(t *testing.T) {
	t.Parallel()
	svc, _, _ := newRealFSSvc(t)
	_, err := svc.Create(context.Background(), "", "a\x00b")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
}

func TestService_Create_RejectsEmptyTitle(t *testing.T) {
	t.Parallel()
	svc, _, _ := newRealFSSvc(t)
	_, err := svc.Create(context.Background(), "", "")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
}

func TestService_Create_Collision(t *testing.T) {
	t.Parallel()
	svc, _, idx := newRealFSSvc(t)

	if _, err := svc.Create(context.Background(), "", "alpha"); err != nil {
		t.Fatalf("first create: %v", err)
	}
	_, err := svc.Create(context.Background(), "", "alpha")
	if err == nil {
		t.Fatalf("expected ErrCaseCollision, got nil")
	}
	if !errors.Is(err, fsstore.ErrCaseCollision) {
		t.Fatalf("err: got %v, want fsstore.ErrCaseCollision", err)
	}
	if idx.count() != 1 {
		t.Errorf("index rows: got %d, want 1", idx.count())
	}
}

func TestService_Create_IndexUpsertFailureRollsBackFile(t *testing.T) {
	t.Parallel()
	svc, root, idx := newRealFSSvc(t)
	idx.upsertErr = errors.New("simulated index failure")

	_, err := svc.Create(context.Background(), "", "alpha")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if fileExists(t, root, "alpha.md") {
		t.Errorf("file not rolled back on index upsert failure")
	}
}

// --- Service.Delete ---

func TestService_Delete_HappyPath(t *testing.T) {
	t.Parallel()
	svc, root, idx := newRealFSSvc(t)

	summary, err := svc.Create(context.Background(), "", "alpha")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := svc.Delete(context.Background(), summary.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if fileExists(t, root, "alpha.md") {
		t.Errorf("file still on disk after Delete")
	}
	if _, ok := idx.recByID(summary.ID); ok {
		t.Errorf("index row still present after Delete")
	}
	if _, ok := svc.registry.Lookup(summary.ID); ok {
		t.Errorf("registry entry still present after Delete")
	}
}

func TestService_Delete_UnknownId(t *testing.T) {
	t.Parallel()
	svc, _, _ := newRealFSSvc(t)
	err := svc.Delete(context.Background(), uuid.New())
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err: got %v, want ErrNotFound", err)
	}
}

func TestService_Delete_FSFailure_RollsBackIndex(t *testing.T) {
	t.Parallel()
	svc, root, idx := newRealFSSvc(t)
	summary, err := svc.Create(context.Background(), "", "alpha")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Inject FS failure by making the path unwritable: out-of-band remove
	// the underlying file so DeleteFile sees fs.ErrNotExist. This
	// simulates a race where the file was already gone — the service
	// should detect the FS error AFTER the index delete and re-Upsert
	// the row to maintain consistency.
	if err := os.Remove(filepath.Join(root, "alpha.md")); err != nil {
		t.Fatalf("remove: %v", err)
	}
	err = svc.Delete(context.Background(), summary.ID)
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	// Index row was index-FIRST deleted, then re-Upserted on FS failure.
	if _, ok := idx.recByID(summary.ID); !ok {
		t.Errorf("index row not rolled back on FS failure (reconciler-heals OK, but best-effort rollback expected)")
	}
	// Registry was never removed (we removed AFTER FS success).
	if _, ok := svc.registry.Lookup(summary.ID); !ok {
		t.Errorf("registry entry missing despite FS-delete failure")
	}
}

// --- Service.Move ---

func TestService_Move_HappyPath(t *testing.T) {
	t.Parallel()
	svc, root, idx := newRealFSSvc(t)
	summary, err := svc.Create(context.Background(), "", "alpha")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	moved, err := svc.Move(context.Background(), summary.ID, "renamed.md")
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	if moved.Path != "renamed.md" {
		t.Errorf("Path: got %q, want %q", moved.Path, "renamed.md")
	}
	if fileExists(t, root, "alpha.md") {
		t.Errorf("old file still present")
	}
	if !fileExists(t, root, "renamed.md") {
		t.Errorf("new file not present")
	}
	rec, ok := idx.recByID(summary.ID)
	if !ok {
		t.Fatalf("index row missing")
	}
	if rec.Path != "renamed.md" {
		t.Errorf("index path: got %q, want %q", rec.Path, "renamed.md")
	}
	if relPath, _ := svc.registry.Lookup(summary.ID); relPath != "renamed.md" {
		t.Errorf("registry: got %q, want %q", relPath, "renamed.md")
	}
}

func TestService_Move_Collision(t *testing.T) {
	t.Parallel()
	svc, root, _ := newRealFSSvc(t)
	a, err := svc.Create(context.Background(), "", "alpha")
	if err != nil {
		t.Fatalf("Create A: %v", err)
	}
	b, err := svc.Create(context.Background(), "", "beta")
	if err != nil {
		t.Fatalf("Create B: %v", err)
	}
	_, err = svc.Move(context.Background(), a.ID, "beta.md")
	if err == nil {
		t.Fatalf("expected ErrCaseCollision, got nil")
	}
	if !errors.Is(err, fsstore.ErrCaseCollision) {
		t.Fatalf("err: got %v, want fsstore.ErrCaseCollision", err)
	}
	// Both notes survive at original paths.
	if !fileExists(t, root, "alpha.md") || !fileExists(t, root, "beta.md") {
		t.Errorf("survivors missing")
	}
	if relPathA, _ := svc.registry.Lookup(a.ID); relPathA != "alpha.md" {
		t.Errorf("registry A: got %q, want alpha.md", relPathA)
	}
	if relPathB, _ := svc.registry.Lookup(b.ID); relPathB != "beta.md" {
		t.Errorf("registry B: got %q, want beta.md", relPathB)
	}
}

// --- Plan 03-21 Gap R2-6: Move refreshes title from renamed-file content ---

// TestService_Move_RefreshesTitle proves the contract introduced by Plan
// 03-21 Task 2: after Service.Move renames a file, the index row's
// Title is re-extracted from the renamed file's CURRENT content via
// markdown.ExtractTitle. The H1 wins over the filename when present;
// the filename change does NOT change the H1, so we observe the H1 in
// both the returned summary and the index row.
func TestService_Move_RefreshesTitle(t *testing.T) {
	t.Parallel()
	svc, _, idx := newRealFSSvc(t)
	summary, err := svc.Create(context.Background(), "", "alpha")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Write H1 content into the file via Update (file-FIRST contract;
	// the index Title field after Update is still empty per the
	// service.go convention — the indexer is the source of truth).
	if _, err := svc.Update(context.Background(), summary.ID, "# Alpha Title\n\nbody", ""); err != nil {
		t.Fatalf("Update: %v", err)
	}

	moved, err := svc.Move(context.Background(), summary.ID, "beta.md")
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	if moved.Title != "Alpha Title" {
		t.Errorf("returned Title: got %q, want %q", moved.Title, "Alpha Title")
	}
	rec, ok := idx.recByID(summary.ID)
	if !ok {
		t.Fatalf("index row missing")
	}
	if rec.Title != "Alpha Title" {
		t.Errorf("index Title: got %q, want %q", rec.Title, "Alpha Title")
	}
}

// TestService_Move_RefreshesTitle_NoH1_FallsBackToFilename: when the
// renamed file has no H1, the title falls back to the new filename
// (without the .md suffix). This matches the markdown.ExtractTitle
// contract and ensures the tree label tracks the filename when no H1
// is present (Obsidian-style binding).
func TestService_Move_RefreshesTitle_NoH1_FallsBackToFilename(t *testing.T) {
	t.Parallel()
	svc, _, idx := newRealFSSvc(t)
	summary, err := svc.Create(context.Background(), "", "alpha")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Write content with NO H1 at all.
	if _, err := svc.Update(context.Background(), summary.ID, "body without heading", ""); err != nil {
		t.Fatalf("Update: %v", err)
	}

	moved, err := svc.Move(context.Background(), summary.ID, "beta.md")
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	if moved.Title != "beta" {
		t.Errorf("returned Title: got %q, want %q", moved.Title, "beta")
	}
	rec, ok := idx.recByID(summary.ID)
	if !ok {
		t.Fatalf("index row missing")
	}
	if rec.Title != "beta" {
		t.Errorf("index Title: got %q, want %q", rec.Title, "beta")
	}
}

// TestService_Move_RefreshesTitle_AfterContentChange: the Move re-reads
// the LATEST content on disk, not a stale snapshot. After two updates
// (# Old → # New Title), the Move sees # New Title.
func TestService_Move_RefreshesTitle_AfterContentChange(t *testing.T) {
	t.Parallel()
	svc, _, idx := newRealFSSvc(t)
	summary, err := svc.Create(context.Background(), "", "alpha")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := svc.Update(context.Background(), summary.ID, "# Old", ""); err != nil {
		t.Fatalf("Update 1: %v", err)
	}
	if _, err := svc.Update(context.Background(), summary.ID, "# New Title\n\nbody", ""); err != nil {
		t.Fatalf("Update 2: %v", err)
	}

	moved, err := svc.Move(context.Background(), summary.ID, "beta.md")
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	if moved.Title != "New Title" {
		t.Errorf("returned Title: got %q, want %q (Move must re-read current content, not stale)", moved.Title, "New Title")
	}
	rec, ok := idx.recByID(summary.ID)
	if !ok {
		t.Fatalf("index row missing")
	}
	if rec.Title != "New Title" {
		t.Errorf("index Title: got %q, want %q", rec.Title, "New Title")
	}
}

// readFailingFileStore wraps a real FileStore and returns fs.ErrNotExist
// from Read for a single canonical path AFTER MoveFile has succeeded —
// simulating a contrived race where the filesystem watcher / external
// process deletes the file between rename and read.
type readFailingFileStore struct {
	FileStore
	failReadFor string
}

func (r *readFailingFileStore) Read(relPath string) ([]byte, error) {
	if relPath == r.failReadFor {
		return nil, fmt.Errorf("simulated read failure: %w", fs.ErrNotExist)
	}
	return r.FileStore.Read(relPath)
}

// TestService_Move_RefreshesTitle_ReadFailureFallsBackGracefully: a
// post-rename Read failure does NOT fail the Move outright. The Move
// MUST succeed and the index row's Title falls back to the filename
// derivation (markdown.ExtractTitle handles nil content). The
// reconciler heals at its next pass if the read failure was transient.
func TestService_Move_RefreshesTitle_ReadFailureFallsBackGracefully(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	realStore := fsstore.NewStore(root)
	idx := newStubIndex()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	wrapped := &readFailingFileStore{FileStore: realStore, failReadFor: "beta.md"}
	svc := NewService(wrapped, idx, nil, logger)

	summary, err := svc.Create(context.Background(), "", "alpha")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := svc.Update(context.Background(), summary.ID, "# Will Not Be Read", ""); err != nil {
		t.Fatalf("Update: %v", err)
	}

	// MoveFile succeeds (real FileStore handles it), but the subsequent
	// Read("beta.md") returns fs.ErrNotExist due to our wrapper.
	moved, err := svc.Move(context.Background(), summary.ID, "beta.md")
	if err != nil {
		t.Fatalf("Move must NOT fail on post-rename read failure; got: %v", err)
	}
	if moved.Path != "beta.md" {
		t.Errorf("Path: got %q, want %q", moved.Path, "beta.md")
	}
	// On read failure the title falls back to the filename-derived
	// value via markdown.ExtractTitle(nil, "beta.md") = "beta".
	if moved.Title != "beta" {
		t.Errorf("Title fallback: got %q, want %q (filename fallback on read failure)", moved.Title, "beta")
	}
	rec, ok := idx.recByID(summary.ID)
	if !ok {
		t.Fatalf("index row missing")
	}
	if rec.Title != "beta" {
		t.Errorf("index Title fallback: got %q, want %q", rec.Title, "beta")
	}
}

// --- Service.CreateFolder ---

func TestService_CreateFolder_HappyPath(t *testing.T) {
	t.Parallel()
	svc, root, _ := newRealFSSvc(t)
	canon, err := svc.CreateFolder(context.Background(), "", "projects")
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	if canon != "projects" {
		t.Errorf("canon: got %q, want %q", canon, "projects")
	}
	if !dirExists(t, root, "projects") {
		t.Errorf("dir not created")
	}
}

func TestService_CreateFolder_RejectsDoubleDot(t *testing.T) {
	t.Parallel()
	svc, _, _ := newRealFSSvc(t)
	_, err := svc.CreateFolder(context.Background(), "", "..")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
}

func TestService_CreateFolder_RejectsSlash(t *testing.T) {
	t.Parallel()
	svc, _, _ := newRealFSSvc(t)
	_, err := svc.CreateFolder(context.Background(), "", "a/b")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
}

// --- Service.DeleteFolder ---

func TestService_DeleteFolder_NotEmpty_NoRecursive(t *testing.T) {
	t.Parallel()
	svc, root, _ := newRealFSSvc(t)
	if _, err := svc.CreateFolder(context.Background(), "", "projects"); err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	if _, err := svc.Create(context.Background(), "projects", "a"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	err := svc.DeleteFolder(context.Background(), "projects", false)
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !errors.Is(err, fsstore.ErrFolderNotEmpty) {
		t.Fatalf("err: got %v, want ErrFolderNotEmpty", err)
	}
	if !dirExists(t, root, "projects") {
		t.Errorf("dir gone")
	}
	if !fileExists(t, root, "projects/a.md") {
		t.Errorf("file gone")
	}
}

func TestService_DeleteFolder_Recursive_BatchDeletesIndex(t *testing.T) {
	t.Parallel()
	svc, root, idx := newRealFSSvc(t)
	if _, err := svc.CreateFolder(context.Background(), "", "trash"); err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	created := []NoteSummary{}
	for _, name := range []string{"a", "b", "c"} {
		s, err := svc.Create(context.Background(), "trash", name)
		if err != nil {
			t.Fatalf("Create %s: %v", name, err)
		}
		created = append(created, s)
	}
	if err := svc.DeleteFolder(context.Background(), "trash", true); err != nil {
		t.Fatalf("DeleteFolder: %v", err)
	}
	if dirExists(t, root, "trash") {
		t.Errorf("dir still present")
	}
	for _, s := range created {
		if _, ok := idx.recByID(s.ID); ok {
			t.Errorf("index still has row for %v", s.ID)
		}
		if _, ok := svc.registry.Lookup(s.ID); ok {
			t.Errorf("registry still has entry for %v", s.ID)
		}
	}
}

// --- Service.MoveFolder ---

func TestService_MoveFolder_HappyPath(t *testing.T) {
	t.Parallel()
	svc, root, idx := newRealFSSvc(t)
	if _, err := svc.CreateFolder(context.Background(), "", "old"); err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	noteSummary, err := svc.Create(context.Background(), "old", "a")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	canon, err := svc.MoveFolder(context.Background(), "old", "new")
	if err != nil {
		t.Fatalf("MoveFolder: %v", err)
	}
	if canon != "new" {
		t.Errorf("canon: got %q, want %q", canon, "new")
	}
	if dirExists(t, root, "old") {
		t.Errorf("old dir still present")
	}
	if !fileExists(t, root, "new/a.md") {
		t.Errorf("file not at new/a.md")
	}
	rec, ok := idx.recByID(noteSummary.ID)
	if !ok {
		t.Fatalf("index row missing")
	}
	if rec.Path != "new/a.md" {
		t.Errorf("index path: got %q, want %q", rec.Path, "new/a.md")
	}
	if relPath, _ := svc.registry.Lookup(noteSummary.ID); relPath != "new/a.md" {
		t.Errorf("registry path: got %q, want %q", relPath, "new/a.md")
	}
}

func TestService_MoveFolder_NestedSubtree(t *testing.T) {
	t.Parallel()
	svc, root, idx := newRealFSSvc(t)
	// Build old/a.md, old/b/c.md, old/d/e/f.md
	_, _ = svc.CreateFolder(context.Background(), "", "old")
	_, _ = svc.CreateFolder(context.Background(), "old", "b")
	_, _ = svc.CreateFolder(context.Background(), "old", "d")
	_, _ = svc.CreateFolder(context.Background(), "old/d", "e")
	a, _ := svc.Create(context.Background(), "old", "a")
	c, _ := svc.Create(context.Background(), "old/b", "c")
	f, _ := svc.Create(context.Background(), "old/d/e", "f")

	if _, err := svc.MoveFolder(context.Background(), "old", "new"); err != nil {
		t.Fatalf("MoveFolder: %v", err)
	}
	if dirExists(t, root, "old") {
		t.Errorf("old dir still present")
	}

	for _, tt := range []struct {
		id   uuid.UUID
		want string
	}{
		{a.ID, "new/a.md"},
		{c.ID, "new/b/c.md"},
		{f.ID, "new/d/e/f.md"},
	} {
		if !fileExists(t, root, tt.want) {
			t.Errorf("file not at %s", tt.want)
		}
		if rec, ok := idx.recByID(tt.id); !ok || rec.Path != tt.want {
			t.Errorf("index for %v: got %q, want %q", tt.id, rec.Path, tt.want)
		}
		if relPath, _ := svc.registry.Lookup(tt.id); relPath != tt.want {
			t.Errorf("registry for %v: got %q, want %q", tt.id, relPath, tt.want)
		}
	}
}

func TestService_MoveFolder_Cycle(t *testing.T) {
	t.Parallel()
	svc, root, _ := newRealFSSvc(t)
	if _, err := svc.CreateFolder(context.Background(), "", "x"); err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	_, err := svc.MoveFolder(context.Background(), "x", "x/y")
	if err == nil {
		t.Fatalf("expected ErrCycle, got nil")
	}
	if !errors.Is(err, fsstore.ErrCycle) {
		t.Fatalf("err: got %v, want ErrCycle", err)
	}
	if !dirExists(t, root, "x") {
		t.Errorf("source dir vanished")
	}
}

// --- Registry dynamic ops ---

func TestRegistry_Add_AndLookup(t *testing.T) {
	t.Parallel()
	r := NewRegistry()
	id := uuid.New()
	r.Add(id, "foo.md")
	got, ok := r.Lookup(id)
	if !ok {
		t.Fatalf("not found")
	}
	if got != "foo.md" {
		t.Errorf("got %q, want %q", got, "foo.md")
	}
}

func TestRegistry_Remove_Idempotent(t *testing.T) {
	t.Parallel()
	r := NewRegistry()
	id := uuid.New()
	r.Add(id, "foo.md")
	r.Remove(id)
	r.Remove(id) // idempotent
	if _, ok := r.Lookup(id); ok {
		t.Errorf("entry still present")
	}
}

func TestRegistry_Rename_OnlyIfPresent(t *testing.T) {
	t.Parallel()
	r := NewRegistry()
	id := uuid.New()
	r.Rename(id, "new.md") // no-op for unknown id
	if _, ok := r.Lookup(id); ok {
		t.Errorf("Rename should not insert for unknown id")
	}
	r.Add(id, "old.md")
	r.Rename(id, "new.md")
	got, _ := r.Lookup(id)
	if got != "new.md" {
		t.Errorf("got %q, want %q", got, "new.md")
	}
}

func TestRegistry_Hydrate_ReplacesAll(t *testing.T) {
	t.Parallel()
	r := NewRegistry()
	preExistingID := uuid.New()
	r.Add(preExistingID, "old.md")
	id1 := uuid.New()
	id2 := uuid.New()
	r.Hydrate([]NoteSummary{
		{ID: id1, Path: "a.md"},
		{ID: id2, Path: "b.md"},
	})
	// pre-existing entry removed unless in summaries
	if _, ok := r.Lookup(preExistingID); ok {
		t.Errorf("pre-existing entry should have been replaced")
	}
	if got, _ := r.Lookup(id1); got != "a.md" {
		t.Errorf("id1: got %q", got)
	}
	if got, _ := r.Lookup(id2); got != "b.md" {
		t.Errorf("id2: got %q", got)
	}
}

func TestRegistry_AddRemoveRename_Concurrency(t *testing.T) {
	t.Parallel()
	r := NewRegistry()
	const n = 50
	ids := make([]uuid.UUID, n)
	for i := range ids {
		ids[i] = uuid.New()
	}
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			r.Add(ids[idx], "p.md")
			r.Rename(ids[idx], "q.md")
			r.Remove(ids[idx])
		}(i)
	}
	wg.Wait()
	// All entries removed at the end (last write was Remove).
	for _, id := range ids {
		if _, ok := r.Lookup(id); ok {
			t.Errorf("entry %v still present after concurrent Remove", id)
		}
	}
}

// --------------------------------------------------------------------------
// Plan 04-04 Task 1: 5 new If-Match / broadcast tests (TDD GREEN)
// --------------------------------------------------------------------------

// TestService_Update_IfMatch_Mismatch_ReturnsErrStaleWrite: when the
// client-supplied If-Match does not match the current file mtime, Update
// returns ErrStaleWrite and does NOT write the file or broadcast.
func TestService_Update_IfMatch_Mismatch_ReturnsErrStaleWrite(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	files := &fakeFileStore{statTime: now}
	idx := &fakeIndex{}
	bc := &fakeBroadcaster{}
	svc := newSvcWithBroadcaster(t, files, idx, bc)

	// ifMatch does NOT match now.UTC().Format(time.RFC3339Nano)
	_, err := svc.Update(context.Background(), ScratchpadUUID, "new content", "wrong-ifmatch-value")
	if !errors.Is(err, ErrStaleWrite) {
		t.Fatalf("expected ErrStaleWrite, got %v", err)
	}
	// File must NOT be written on rejected stale write.
	if files.writeCalls != 0 {
		t.Errorf("WriteAtomic must not be called on stale write; got %d calls", files.writeCalls)
	}
	// No broadcast on rejected write.
	if len(bc.calls) != 0 {
		t.Errorf("no broadcast expected on rejected stale write; got %v", bc.calls)
	}
}

// TestService_Update_IfMatch_Empty_SkipsValidation: empty ifMatch is
// permissive — the write succeeds even though the stat mtime is set.
// This is the curl/automation-friendly path (SYNC-06).
func TestService_Update_IfMatch_Empty_SkipsValidation(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	files := &fakeFileStore{statTime: now}
	idx := &fakeIndex{}
	bc := &fakeBroadcaster{}
	svc := newSvcWithBroadcaster(t, files, idx, bc)

	// Empty ifMatch → permissive, no validation step.
	note, err := svc.Update(context.Background(), ScratchpadUUID, "content", "")
	if err != nil {
		t.Fatalf("empty ifMatch should be permissive; got error: %v", err)
	}
	if files.writeCalls != 1 {
		t.Errorf("writeCalls: got %d, want 1", files.writeCalls)
	}
	if note.UpdatedAt.IsZero() {
		t.Errorf("UpdatedAt is zero")
	}
}

// TestService_Update_IfMatch_Match_ProceedsAsNormal: a correctly-formed
// If-Match that matches the current file's mtime proceeds and broadcasts.
func TestService_Update_IfMatch_Match_ProceedsAsNormal(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	files := &fakeFileStore{statTime: now}
	idx := &fakeIndex{}
	bc := &fakeBroadcaster{}
	svc := newSvcWithBroadcaster(t, files, idx, bc)

	// Format mtime as RFC3339Nano UTC — same as Service.Update does.
	ifMatch := now.UTC().Format(time.RFC3339Nano)
	note, err := svc.Update(context.Background(), ScratchpadUUID, "content", ifMatch)
	if err != nil {
		t.Fatalf("matching If-Match should succeed; got error: %v", err)
	}
	if files.writeCalls != 1 {
		t.Errorf("writeCalls: got %d, want 1", files.writeCalls)
	}
	if note.UpdatedAt.IsZero() {
		t.Errorf("UpdatedAt is zero")
	}
	// Successful match → both EventNoteUpdated and EventTagsUpdated fire (Phase 6).
	if len(bc.calls) != 2 {
		t.Errorf("expected 2 broadcasts (EventNoteUpdated + EventTagsUpdated); got %d", len(bc.calls))
	}
}

// TestService_Update_BroadcastsAfterIndexUpsert: verifies the canonical
// file-FIRST ordering (ARCHITECTURE.md §11.1): write → upsert → broadcast.
// Also asserts T-04-04: payload must NOT contain a "content" key.
func TestService_Update_BroadcastsAfterIndexUpsert(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	var seq []string
	files := &fakeFileStore{statTime: now, observedSeq: &seq}
	idx := &fakeIndex{observedSeq: &seq}
	bc := &fakeBroadcaster{observedSeq: &seq}
	svc := newSvcWithBroadcaster(t, files, idx, bc)

	_, err := svc.Update(context.Background(), ScratchpadUUID, "new content", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Ordering: write → upsert → broadcast → broadcast (Phase 6: EventNoteUpdated + EventTagsUpdated).
	want := []string{"write", "upsert", "broadcast", "broadcast"}
	if len(seq) != 4 || seq[0] != want[0] || seq[1] != want[1] || seq[2] != want[2] || seq[3] != want[3] {
		t.Fatalf("ordering: got %v, want %v", seq, want)
	}

	// T-04-04: payload must not include note content.
	// Check the first broadcast (EventNoteUpdated) has required metadata.
	if len(bc.calls) != 2 {
		t.Fatalf("expected 2 broadcast calls (EventNoteUpdated + EventTagsUpdated); got %d", len(bc.calls))
	}
	payload, ok := bc.calls[0].payload.(map[string]any)
	if !ok {
		t.Fatalf("payload is not map[string]any; got %T", bc.calls[0].payload)
	}
	if _, hasContent := payload["content"]; hasContent {
		t.Fatal("T-04-04 violation: broadcast payload must not include note content")
	}
	// Verify metadata fields present in EventNoteUpdated payload.
	for _, key := range []string{"id", "path", "updated_at"} {
		if _, ok := payload[key]; !ok {
			t.Errorf("broadcast payload missing key %q", key)
		}
	}
}

// TestService_Update_NoBroadcastOnTransientIndexError: when Index.Upsert
// returns a transient (non-collision) error, the file is on disk but the
// broadcast must NOT fire (Pitfall 2 — broadcast only after index succeeds).
func TestService_Update_NoBroadcastOnTransientIndexError(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	files := &fakeFileStore{statTime: now}
	idx := &fakeIndex{upsertErr: errors.New("transient sqlite busy")}
	bc := &fakeBroadcaster{}
	svc := newSvcWithBroadcaster(t, files, idx, bc)

	// Update returns success (file-FIRST contract: transient index errors
	// are logged+swallowed). But broadcast must NOT have fired.
	_, err := svc.Update(context.Background(), ScratchpadUUID, "content", "")
	if err != nil {
		t.Fatalf("transient index error must not propagate; got %v", err)
	}
	if len(bc.calls) != 0 {
		t.Errorf("no broadcast expected on transient index error; got %v", bc.calls)
	}
}

// --------------------------------------------------------------------------
// Phase 6 Plan 06-05 Task 1: Service.Update Phase 6 extensions
// --------------------------------------------------------------------------

// TestService_Update_AutoRestoresMissingFrontmatter (D-10 / TAGS-EXT-02):
// when content has no frontmatter block, Update should inject the scaffold
// before writing to disk.
func TestService_Update_AutoRestoresMissingFrontmatter(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	files := &fakeFileStore{statTime: now}
	bc := &fakeBroadcaster{}
	svc := newSvcWithBroadcaster(t, files, nil, bc)

	content := "# Just a Heading\nno frontmatter"
	_, err := svc.Update(context.Background(), ScratchpadUUID, content, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Written bytes must start with frontmatter scaffold.
	written := string(files.lastWriteData)
	if !strings.HasPrefix(written, "---\ntags: []\n---\n") {
		t.Errorf("D-10: file written without frontmatter scaffold; got: %q", written[:min(80, len(written))])
	}
	// Original content must still be present.
	if !strings.Contains(written, "# Just a Heading") {
		t.Errorf("original heading not preserved in written content")
	}
}

// TestService_Update_PreservesExistingFrontmatter (Test 5): when content
// already has frontmatter, no double-injection should occur.
func TestService_Update_PreservesExistingFrontmatter(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	files := &fakeFileStore{statTime: now}
	svc := newSvc(t, files)

	content := "---\ntags: [foo]\n---\n\n# Heading\nbody"
	_, err := svc.Update(context.Background(), ScratchpadUUID, content, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	written := string(files.lastWriteData)
	if written != content {
		t.Errorf("content with existing frontmatter should be written verbatim; got %q", written)
	}
}

// TestService_Update_BroadcastsEventTagsUpdated (Test 6): on successful
// save + successful index upsert, both EventNoteUpdated AND EventTagsUpdated
// should be broadcast.
func TestService_Update_BroadcastsEventTagsUpdated(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	files := &fakeFileStore{statTime: now}
	idx := &fakeIndex{}
	bc := &fakeBroadcaster{}
	svc := newSvcWithBroadcaster(t, files, idx, bc)

	content := "---\ntags: [foo]\n---\n\n# Note"
	_, err := svc.Update(context.Background(), ScratchpadUUID, content, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify EventTagsUpdated was broadcast.
	found := false
	for _, c := range bc.calls {
		if c.event == EventTagsUpdated {
			found = true
			// Payload must contain note_id.
			payload, ok := c.payload.(map[string]any)
			if !ok {
				t.Fatalf("EventTagsUpdated payload is not map[string]any: %T", c.payload)
			}
			if _, hasID := payload["note_id"]; !hasID {
				t.Errorf("EventTagsUpdated payload missing note_id key")
			}
		}
	}
	if !found {
		t.Errorf("EventTagsUpdated was not broadcast; got calls: %+v", bc.calls)
	}
}

// ---------------------------------------------------------------------------
// Task 3: cross-vault index double — tagStubIndex
//
// tagStubIndex embeds stubIndex and adds in-memory tag + backlink tracking
// so Task 3 tests can assert on NotesByTag / RenameTag / DeleteTag /
// SourcesByBacklinkTitle / UpdateBacklinksTargetTitle without importing the
// index package (which imports notes, creating a test-time cycle).
// ---------------------------------------------------------------------------

// tagStubIndex is a richer Index spy that supports tag + backlink operations
// in memory. Embeds stubIndex for the base Upsert / Delete / List / etc.
// methods. Tag and backlink state is managed separately.
type tagStubIndex struct {
	*stubIndex // base Upsert/Delete/List/LookupByPath/etc.

	mu sync.RWMutex

	// tags: tag name → set of note IDs carrying it.
	tags map[string]map[uuid.UUID]bool

	// backlinks: target title → set of source note IDs.
	backlinks map[string]map[uuid.UUID]bool

	// byID index for NoteSummary lookups.
	// Populated by overriding Upsert.
	summaries map[uuid.UUID]NoteSummary

	// Failure injection for RenameTag / DeleteTag.
	renameTagErr error
	deleteTagErr error

	// renameTagCalled / deleteTagCalled record the call arguments.
	renameTagCalled []string // [old, new]
	deleteTagCalled []string // [name]

	// updateBacklinksCalled records calls.
	updateBacklinksCalled bool
}

func newTagStubIndex() *tagStubIndex {
	return &tagStubIndex{
		stubIndex: newStubIndex(),
		tags:      make(map[string]map[uuid.UUID]bool),
		backlinks: make(map[string]map[uuid.UUID]bool),
		summaries: make(map[uuid.UUID]NoteSummary),
	}
}

// Upsert overrides stubIndex.Upsert to also populate summaries.
func (t *tagStubIndex) Upsert(ctx context.Context, rec NoteRecord) error {
	if err := t.stubIndex.Upsert(ctx, rec); err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.summaries[rec.ID] = NoteSummary{ID: rec.ID, Path: rec.Path, Title: rec.Title}
	return nil
}

// setTag adds noteID as a carrier of tagName.
func (t *tagStubIndex) setTag(tagName string, noteID uuid.UUID) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tags[tagName] == nil {
		t.tags[tagName] = make(map[uuid.UUID]bool)
	}
	t.tags[tagName][noteID] = true
}

// setBacklink records that sourceID contains [[targetTitle]].
func (t *tagStubIndex) setBacklink(targetTitle string, sourceID uuid.UUID) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.backlinks[targetTitle] == nil {
		t.backlinks[targetTitle] = make(map[uuid.UUID]bool)
	}
	t.backlinks[targetTitle][sourceID] = true
}

func (t *tagStubIndex) NotesByTag(_ context.Context, name string) ([]NoteSummary, error) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	carriers := t.tags[name]
	out := make([]NoteSummary, 0, len(carriers))
	for id := range carriers {
		if s, ok := t.summaries[id]; ok {
			out = append(out, s)
		}
	}
	return out, nil
}

func (t *tagStubIndex) RenameTag(_ context.Context, oldName, newName string) ([]uuid.UUID, error) {
	if t.renameTagErr != nil {
		return nil, t.renameTagErr
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.renameTagCalled = []string{oldName, newName}
	carriers := t.tags[oldName]
	if len(carriers) == 0 {
		return nil, nil
	}
	// Move the tag set to the new name.
	t.tags[newName] = carriers
	delete(t.tags, oldName)
	ids := make([]uuid.UUID, 0, len(carriers))
	for id := range carriers {
		ids = append(ids, id)
	}
	return ids, nil
}

func (t *tagStubIndex) DeleteTag(_ context.Context, name string) ([]uuid.UUID, error) {
	if t.deleteTagErr != nil {
		return nil, t.deleteTagErr
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.deleteTagCalled = append(t.deleteTagCalled, name)
	carriers := t.tags[name]
	ids := make([]uuid.UUID, 0, len(carriers))
	for id := range carriers {
		ids = append(ids, id)
	}
	delete(t.tags, name)
	return ids, nil
}

func (t *tagStubIndex) SourcesByBacklinkTitle(_ context.Context, title string) ([]NoteSummary, error) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	sources := t.backlinks[title]
	out := make([]NoteSummary, 0, len(sources))
	for id := range sources {
		if s, ok := t.summaries[id]; ok {
			out = append(out, s)
		}
	}
	return out, nil
}

func (t *tagStubIndex) UpdateBacklinksTargetTitle(_ context.Context, oldTitle, newTitle string, _ *uuid.UUID) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.updateBacklinksCalled = true
	if sources, ok := t.backlinks[oldTitle]; ok {
		t.backlinks[newTitle] = sources
		delete(t.backlinks, oldTitle)
	}
	return nil
}

// newCrossVaultSvc constructs a Service backed by a real fsstore.Store
// rooted at a freshly-allocated tempdir + a tagStubIndex for cross-vault
// rewrite tests. Returns the service, the store root, the tag index spy,
// and a fakeBroadcaster.
func newCrossVaultSvc(t *testing.T) (*Service, string, *tagStubIndex, *fakeBroadcaster) {
	t.Helper()
	root := t.TempDir()
	store := fsstore.NewStore(root)
	idx := newTagStubIndex()
	bc := &fakeBroadcaster{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := NewService(store, idx, bc, logger)
	return svc, root, idx, bc
}

// createTestNote writes a note file and registers it in the service registry.
// Returns the note's UUID.
func createTestNote(t *testing.T, svc *Service, root, relPath, content string) uuid.UUID {
	t.Helper()
	fullPath := filepath.Join(root, relPath)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile %s: %v", relPath, err)
	}
	id := uuid.New()
	svc.registry.Add(id, relPath)
	return id
}

// ---------------------------------------------------------------------------
// Task 3 RED tests: RenameTagAcrossVault
// ---------------------------------------------------------------------------

// PT1: 3 notes carry "foo"; rename to "feature"; returns 3 ids; on-disk tags
// arrays now contain "feature".
func TestService_RenameTagAcrossVault_PT1_BasicRename(t *testing.T) {
	t.Parallel()
	svc, root, idx, bc := newCrossVaultSvc(t)
	ctx := context.Background()

	const oldTag = "foo"
	const newTag = "feature"

	// Set up 3 carrier notes with the tag in their frontmatter.
	idA := createTestNote(t, svc, root, "a.md", "---\ntags: [foo, bar]\n---\n\nbody A")
	idB := createTestNote(t, svc, root, "b.md", "---\ntags: [foo]\n---\n\nbody B")
	idC := createTestNote(t, svc, root, "c.md", "---\ntags: [foo, baz]\n---\n\nbody C")

	// Register NoteRecords in the tag stub so NotesByTag returns them.
	_ = idx.Upsert(ctx, NoteRecord{ID: idA, Path: "a.md", Title: "a"})
	_ = idx.Upsert(ctx, NoteRecord{ID: idB, Path: "b.md", Title: "b"})
	_ = idx.Upsert(ctx, NoteRecord{ID: idC, Path: "c.md", Title: "c"})
	idx.setTag(oldTag, idA)
	idx.setTag(oldTag, idB)
	idx.setTag(oldTag, idC)

	touched, err := svc.RenameTagAcrossVault(ctx, oldTag, newTag)
	if err != nil {
		t.Fatalf("RenameTagAcrossVault: %v", err)
	}
	if len(touched) != 3 {
		t.Errorf("touched: got %d, want 3", len(touched))
	}

	// On-disk tags arrays should now contain "feature".
	for _, relPath := range []string{"a.md", "b.md", "c.md"} {
		data, err := os.ReadFile(filepath.Join(root, relPath))
		if err != nil {
			t.Fatalf("ReadFile %s: %v", relPath, err)
		}
		s := string(data)
		if !strings.Contains(s, newTag) {
			t.Errorf("%s: on-disk content missing %q; got: %q", relPath, newTag, s)
		}
		if strings.Contains(s, oldTag) {
			t.Errorf("%s: on-disk content still contains %q; got: %q", relPath, oldTag, s)
		}
	}

	// SQL rename called.
	if idx.renameTagCalled == nil || idx.renameTagCalled[0] != oldTag || idx.renameTagCalled[1] != newTag {
		t.Errorf("RenameTag not called with correct args; got %v", idx.renameTagCalled)
	}

	// Broadcast fires once with EventTagsRewritten.
	var found bool
	for _, c := range bc.calls {
		if c.event == EventTagsRewritten {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("EventTagsRewritten not broadcast; calls: %+v", bc.calls)
	}
}

// PT2: oldName not found → ErrTagNotFound.
func TestService_RenameTagAcrossVault_PT2_NotFound(t *testing.T) {
	t.Parallel()
	svc, _, _, _ := newCrossVaultSvc(t)

	_, err := svc.RenameTagAcrossVault(context.Background(), "nonexistent", "other")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	// The error should indicate not found (either ErrTagNotFound or a wrapped version).
	if !strings.Contains(err.Error(), "not found") && !strings.Contains(err.Error(), "tag") {
		t.Errorf("expected tag-not-found error; got: %v", err)
	}
}

// PT3: invalid newName charset → error.
func TestService_RenameTagAcrossVault_PT3_InvalidNewName(t *testing.T) {
	t.Parallel()
	svc, _, _, _ := newCrossVaultSvc(t)

	_, err := svc.RenameTagAcrossVault(context.Background(), "foo", "INVALID_UPPERCASE")
	if err == nil {
		t.Fatal("expected error for invalid newName, got nil")
	}
}

// PT5 (D-37 rollback): AtomicWrite failure on the second file restores the
// first file to its pre-state; no broadcast.
func TestService_RenameTagAcrossVault_PT5_Rollback(t *testing.T) {
	t.Parallel()
	// Use a wrapping FileStore that fails on the Nth WriteAtomic call.
	root := t.TempDir()

	callCount := 0
	inner := fsstore.NewStore(root)
	ws := &countingFileStore{inner: inner, failAt: 2, count: &callCount}

	idx := newTagStubIndex()
	bc := &fakeBroadcaster{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := NewService(ws, idx, bc, logger)

	ctx := context.Background()
	const oldTag = "foo"
	const newTag = "new-name"

	idA := createTestNote(t, svc, root, "a.md", "---\ntags: [foo]\n---\n\nbody A")
	idB := createTestNote(t, svc, root, "b.md", "---\ntags: [foo]\n---\n\nbody B")
	idx.setTag(oldTag, idA)
	idx.setTag(oldTag, idB)
	_ = idx.Upsert(ctx, NoteRecord{ID: idA, Path: "a.md", Title: "a"})
	_ = idx.Upsert(ctx, NoteRecord{ID: idB, Path: "b.md", Title: "b"})

	_, err := svc.RenameTagAcrossVault(ctx, oldTag, newTag)
	if err == nil {
		t.Fatal("expected error from failed write, got nil")
	}

	// The first file must be restored to pre-state.
	data, readErr := os.ReadFile(filepath.Join(root, "a.md"))
	if readErr != nil {
		t.Fatalf("ReadFile a.md: %v", readErr)
	}
	if strings.Contains(string(data), newTag) {
		t.Errorf("a.md was NOT rolled back; still contains %q", newTag)
	}
	if !strings.Contains(string(data), oldTag) {
		t.Errorf("a.md was NOT rolled back; missing %q", oldTag)
	}

	// No broadcast on failure.
	for _, c := range bc.calls {
		if c.event == EventTagsRewritten {
			t.Errorf("EventTagsRewritten broadcast despite rollback")
		}
	}
}

// ---------------------------------------------------------------------------
// Task 3 RED tests: DeleteTagAcrossVault
// ---------------------------------------------------------------------------

// DT1: 3 carriers → returns 3 ids; on-disk tags arrays no longer contain tag.
func TestService_DeleteTagAcrossVault_DT1_BasicDelete(t *testing.T) {
	t.Parallel()
	svc, root, idx, bc := newCrossVaultSvc(t)
	ctx := context.Background()

	const tag = "foo"

	idA := createTestNote(t, svc, root, "a.md", "---\ntags: [foo, bar]\n---\n\nbody")
	idB := createTestNote(t, svc, root, "b.md", "---\ntags: [foo]\n---\n\nbody")
	idC := createTestNote(t, svc, root, "c.md", "---\ntags: [baz, foo]\n---\n\nbody")
	idx.setTag(tag, idA)
	idx.setTag(tag, idB)
	idx.setTag(tag, idC)
	_ = idx.Upsert(ctx, NoteRecord{ID: idA, Path: "a.md", Title: "a"})
	_ = idx.Upsert(ctx, NoteRecord{ID: idB, Path: "b.md", Title: "b"})
	_ = idx.Upsert(ctx, NoteRecord{ID: idC, Path: "c.md", Title: "c"})

	touched, err := svc.DeleteTagAcrossVault(ctx, tag)
	if err != nil {
		t.Fatalf("DeleteTagAcrossVault: %v", err)
	}
	if len(touched) != 3 {
		t.Errorf("touched: got %d, want 3", len(touched))
	}

	for _, relPath := range []string{"a.md", "b.md", "c.md"} {
		data, err := os.ReadFile(filepath.Join(root, relPath))
		if err != nil {
			t.Fatalf("ReadFile %s: %v", relPath, err)
		}
		if strings.Contains(string(data), tag) {
			t.Errorf("%s: on-disk content still contains %q", relPath, tag)
		}
	}

	// Broadcast fires with new_name=null.
	var found bool
	for _, c := range bc.calls {
		if c.event == EventTagsRewritten {
			found = true
			payload, _ := c.payload.(map[string]any)
			if payload["new_name"] != nil {
				t.Errorf("DeleteTag broadcast: new_name should be nil, got %v", payload["new_name"])
			}
			break
		}
	}
	if !found {
		t.Errorf("EventTagsRewritten not broadcast; calls: %+v", bc.calls)
	}
}

// DT2: tag not found → error.
func TestService_DeleteTagAcrossVault_DT2_NotFound(t *testing.T) {
	t.Parallel()
	svc, _, _, _ := newCrossVaultSvc(t)

	_, err := svc.DeleteTagAcrossVault(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent tag, got nil")
	}
}

// ---------------------------------------------------------------------------
// Task 3 RED tests: RenameRewriteWikilinks
// ---------------------------------------------------------------------------

// RW1: 3 referrers contain [[Foo]]; rename to "Bar"; on-disk files contain [[Bar]].
func TestService_RenameRewriteWikilinks_RW1_BasicRename(t *testing.T) {
	t.Parallel()
	svc, root, idx, bc := newCrossVaultSvc(t)
	ctx := context.Background()

	idA := createTestNote(t, svc, root, "a.md", "see [[Foo]] and [[Foo|alias]]")
	idB := createTestNote(t, svc, root, "b.md", "also [[Foo]] here")
	idC := createTestNote(t, svc, root, "c.md", "no wikilinks here")
	idx.setBacklink("Foo", idA)
	idx.setBacklink("Foo", idB)
	idx.summaries[idA] = NoteSummary{ID: idA, Path: "a.md", Title: "a"}
	idx.summaries[idB] = NoteSummary{ID: idB, Path: "b.md", Title: "b"}
	idx.summaries[idC] = NoteSummary{ID: idC, Path: "c.md", Title: "c"}

	touched, err := svc.RenameRewriteWikilinks(ctx, "Foo", "Bar")
	if err != nil {
		t.Fatalf("RenameRewriteWikilinks: %v", err)
	}
	if len(touched) != 2 {
		t.Errorf("touched: got %d, want 2", len(touched))
	}

	// a.md: [[Foo]] → [[Bar]], [[Foo|alias]] → [[Bar|alias]]
	dataA, err := os.ReadFile(filepath.Join(root, "a.md"))
	if err != nil {
		t.Fatalf("ReadFile a.md: %v", err)
	}
	sA := string(dataA)
	if !strings.Contains(sA, "[[Bar]]") {
		t.Errorf("a.md: expected [[Bar]]; got: %q", sA)
	}
	if !strings.Contains(sA, "[[Bar|alias]]") {
		t.Errorf("a.md: expected [[Bar|alias]] (D-21); got: %q", sA)
	}
	if strings.Contains(sA, "[[Foo]]") {
		t.Errorf("a.md: still contains [[Foo]]; got: %q", sA)
	}

	// b.md: [[Foo]] → [[Bar]]
	dataB, err := os.ReadFile(filepath.Join(root, "b.md"))
	if err != nil {
		t.Fatalf("ReadFile b.md: %v", err)
	}
	if !strings.Contains(string(dataB), "[[Bar]]") {
		t.Errorf("b.md: expected [[Bar]]; got: %q", string(dataB))
	}

	// c.md: unchanged
	dataC, err := os.ReadFile(filepath.Join(root, "c.md"))
	if err != nil {
		t.Fatalf("ReadFile c.md: %v", err)
	}
	if string(dataC) != "no wikilinks here" {
		t.Errorf("c.md should be unchanged; got: %q", string(dataC))
	}

	// Broadcast fires.
	var found bool
	for _, c := range bc.calls {
		if c.event == EventLinksRewritten {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("EventLinksRewritten not broadcast; calls: %+v", bc.calls)
	}
}

// RW2: zero referrers → returns empty slice; no broadcast.
func TestService_RenameRewriteWikilinks_RW2_NoReferrers(t *testing.T) {
	t.Parallel()
	svc, _, _, bc := newCrossVaultSvc(t)

	touched, err := svc.RenameRewriteWikilinks(context.Background(), "Nobody", "Renamed")
	if err != nil {
		t.Fatalf("RenameRewriteWikilinks: %v", err)
	}
	if len(touched) != 0 {
		t.Errorf("touched: got %d, want 0", len(touched))
	}
	for _, c := range bc.calls {
		if c.event == EventLinksRewritten {
			t.Errorf("EventLinksRewritten broadcast for zero referrers")
		}
	}
}

// RW3: D-36 rollback — AtomicWrite fails on second file; first file restored.
func TestService_RenameRewriteWikilinks_RW3_Rollback(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	callCount := 0
	inner := fsstore.NewStore(root)
	ws := &countingFileStore{inner: inner, failAt: 2, count: &callCount}

	idx := newTagStubIndex()
	bc := &fakeBroadcaster{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := NewService(ws, idx, bc, logger)
	ctx := context.Background()

	idA := createTestNote(t, svc, root, "a.md", "see [[Foo]]")
	idB := createTestNote(t, svc, root, "b.md", "also [[Foo]]")
	idx.setBacklink("Foo", idA)
	idx.setBacklink("Foo", idB)
	idx.summaries[idA] = NoteSummary{ID: idA, Path: "a.md", Title: "a"}
	idx.summaries[idB] = NoteSummary{ID: idB, Path: "b.md", Title: "b"}

	_, err := svc.RenameRewriteWikilinks(ctx, "Foo", "Bar")
	if err == nil {
		t.Fatal("expected error from failed write, got nil")
	}

	// First file must be restored.
	data, readErr := os.ReadFile(filepath.Join(root, "a.md"))
	if readErr != nil {
		t.Fatalf("ReadFile a.md: %v", readErr)
	}
	if strings.Contains(string(data), "[[Bar]]") {
		t.Errorf("a.md not rolled back; still contains [[Bar]]")
	}
	if !strings.Contains(string(data), "[[Foo]]") {
		t.Errorf("a.md not rolled back; missing [[Foo]]")
	}

	// No broadcast on failure.
	for _, c := range bc.calls {
		if c.event == EventLinksRewritten {
			t.Errorf("EventLinksRewritten broadcast despite rollback")
		}
	}
}

// RW5: backlinks table updated after FS pass — UpdateBacklinksTargetTitle called.
func TestService_RenameRewriteWikilinks_RW5_IndexUpdated(t *testing.T) {
	t.Parallel()
	svc, root, idx, _ := newCrossVaultSvc(t)
	ctx := context.Background()

	idA := createTestNote(t, svc, root, "a.md", "see [[Foo]]")
	idx.setBacklink("Foo", idA)
	idx.summaries[idA] = NoteSummary{ID: idA, Path: "a.md", Title: "a"}

	_, err := svc.RenameRewriteWikilinks(ctx, "Foo", "Bar")
	if err != nil {
		t.Fatalf("RenameRewriteWikilinks: %v", err)
	}

	if !idx.updateBacklinksCalled {
		t.Errorf("UpdateBacklinksTargetTitle was not called after FS pass")
	}
}

// RW6: broadcast fires once for non-empty touched set.
func TestService_RenameRewriteWikilinks_RW6_BroadcastOnce(t *testing.T) {
	t.Parallel()
	svc, root, idx, bc := newCrossVaultSvc(t)
	ctx := context.Background()

	idA := createTestNote(t, svc, root, "a.md", "[[Alpha]] [[Alpha]] [[Alpha]]")
	idx.setBacklink("Alpha", idA)
	idx.summaries[idA] = NoteSummary{ID: idA, Path: "a.md", Title: "a"}

	_, err := svc.RenameRewriteWikilinks(ctx, "Alpha", "Beta")
	if err != nil {
		t.Fatalf("RenameRewriteWikilinks: %v", err)
	}

	count := 0
	for _, c := range bc.calls {
		if c.event == EventLinksRewritten {
			count++
		}
	}
	if count != 1 {
		t.Errorf("EventLinksRewritten count: got %d, want 1", count)
	}
}

// ---------------------------------------------------------------------------
// countingFileStore — wraps a FileStore; fails WriteAtomic on the Nth call.
// Used for D-36/D-37 rollback tests.
// ---------------------------------------------------------------------------

type countingFileStore struct {
	inner  FileStore
	failAt int
	count  *int
}

func (c *countingFileStore) Read(relPath string) ([]byte, error) { return c.inner.Read(relPath) }
func (c *countingFileStore) Stat(relPath string) (time.Time, error) {
	return c.inner.Stat(relPath)
}
func (c *countingFileStore) CreateFile(relPath string) error { return c.inner.CreateFile(relPath) }
func (c *countingFileStore) DeleteFile(relPath string) error { return c.inner.DeleteFile(relPath) }
func (c *countingFileStore) MoveFile(oldPath, newPath string) error {
	return c.inner.MoveFile(oldPath, newPath)
}
func (c *countingFileStore) CreateDir(relPath string) error { return c.inner.CreateDir(relPath) }
func (c *countingFileStore) DeleteDir(relPath string, recursive bool) error {
	return c.inner.DeleteDir(relPath, recursive)
}

func (c *countingFileStore) MoveDir(oldPath, newPath string) error {
	return c.inner.MoveDir(oldPath, newPath)
}

func (c *countingFileStore) WriteAtomic(relPath string, data []byte) error {
	*c.count++
	if *c.count == c.failAt {
		return fmt.Errorf("injected write failure at call %d", *c.count)
	}
	return c.inner.WriteAtomic(relPath, data)
}

// TestService_Create_UsesNewNoteContentScaffold (Test 7 / D-09 / TAGS-EXT-01):
// Service.Create must write the standard scaffold content.
func TestService_Create_UsesNewNoteContentScaffold(t *testing.T) {
	t.Parallel()
	svc, root, _ := newRealFSSvc(t)

	summary, err := svc.Create(context.Background(), "", "MyNote")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Read the written file.
	data, err := os.ReadFile(filepath.Join(root, summary.Path))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	written := string(data)
	if !strings.HasPrefix(written, "---\ntags: []\n---\n") {
		t.Errorf("D-09: created file missing frontmatter scaffold; got: %q", written[:min(80, len(written))])
	}
	if !strings.Contains(written, "# MyNote") {
		t.Errorf("D-09: created file missing H1; got: %q", written)
	}
}
