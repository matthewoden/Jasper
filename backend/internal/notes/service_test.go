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
	svc := NewService(store, idx, logger)
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
	if _, err := svc.Update(context.Background(), summary.ID, "# Alpha Title\n\nbody"); err != nil {
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
	if _, err := svc.Update(context.Background(), summary.ID, "body without heading"); err != nil {
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
	if _, err := svc.Update(context.Background(), summary.ID, "# Old"); err != nil {
		t.Fatalf("Update 1: %v", err)
	}
	if _, err := svc.Update(context.Background(), summary.ID, "# New Title\n\nbody"); err != nil {
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
	svc := NewService(wrapped, idx, logger)

	summary, err := svc.Create(context.Background(), "", "alpha")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := svc.Update(context.Background(), summary.ID, "# Will Not Be Read"); err != nil {
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
