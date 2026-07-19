package bookmarks

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Sentinel errors returned by Service mutation methods.
var (
	// ErrNotFound is returned by Remove/MoveToFolder when the bookmark id
	// does not exist in the loaded document.
	ErrNotFound = errors.New("bookmarks: not found")
	// ErrNoteNotFound is returned by Add when noteID does not resolve in
	// the notes.Registry (T-27-01: reject forged/unknown noteId).
	ErrNoteNotFound = errors.New("bookmarks: note not found")
	// ErrFolderNotFound is returned when a non-nil folderId does not exist
	// in the loaded document's Folders.
	ErrFolderNotFound = errors.New("bookmarks: folder not found")
	// ErrInvalidName is returned by CreateFolder for an empty/whitespace name.
	ErrInvalidName = errors.New("bookmarks: invalid name")
)

// Service is the bookmarks domain service. Every mutation follows a
// read-modify-write shape over the flat-file document: Load(dataDir,
// registry, log) -> mutate in-memory -> Save(dataDir, doc) -> broadcast.
// Mirrors notes.Service's Delete/Move/CreateFolder shape (notes/service.go).
type Service struct {
	dataDir     string
	registry    *notes.Registry
	broadcaster notes.Broadcaster
	log         *slog.Logger

	// mu serializes every mutation method's Load -> mutate -> Save cycle
	// (WR-01). Without it, two concurrent requests against the same shared
	// bookmarks.json — e.g. two browser tabs, an explicit multi-session
	// Jasper feature — can both Load the same pre-mutation document and
	// have one Save silently clobber the other's change.
	mu sync.Mutex
}

// New constructs the service. Passing nil for broadcaster substitutes a
// nopBroadcaster no-op, exactly like notes.NewService. A nil log is
// replaced with slog.Default().
func New(dataDir string, registry *notes.Registry, broadcaster notes.Broadcaster, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	if broadcaster == nil {
		broadcaster = nopBroadcaster{}
	}
	return &Service{
		dataDir:     dataDir,
		registry:    registry,
		broadcaster: broadcaster,
		log:         log,
	}
}

type nopBroadcaster struct{}

func (nopBroadcaster) Broadcast(_ string, _ any, _ string) {}

// Add appends a new Bookmark for noteID and persists it. Rejects a noteID
// that does not resolve in the registry with ErrNoteNotFound (security
// control T-27-01) WITHOUT persisting. Rejects a non-nil folderID that
// does not exist in the loaded document with ErrFolderNotFound.
func (s *Service) Add(ctx context.Context, noteID uuid.UUID, folderID *string) (Bookmark, error) {
	// WR-03: a nil registry means notesSvc was nil at construction (Server's
	// documented graceful-degradation contract) — nothing resolves, so
	// treat it the same as "note not found" rather than panicking on
	// registry.Lookup's nil receiver.
	if s.registry == nil {
		return Bookmark{}, fmt.Errorf("bookmarks.Add(%s): %w", noteID, ErrNoteNotFound)
	}
	if _, ok := s.registry.Lookup(noteID); !ok {
		return Bookmark{}, fmt.Errorf("bookmarks.Add(%s): %w", noteID, ErrNoteNotFound)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	doc, err := Load(s.dataDir, s.registry, s.log)
	if err != nil {
		return Bookmark{}, fmt.Errorf("bookmarks.Add: %w", err)
	}

	if folderID != nil && !folderExists(doc.Folders, *folderID) {
		return Bookmark{}, fmt.Errorf("bookmarks.Add: folder %s: %w", *folderID, ErrFolderNotFound)
	}

	bm := Bookmark{
		ID:       uuid.NewString(),
		NoteID:   noteID.String(),
		FolderID: folderID,
		// Order is scoped per-folder (WR-02), matching the OpenAPI contract's
		// "display order among sibling bookmarks" — NOT a global counter,
		// which would collide across unrelated folders and after removals.
		Order: countInFolder(doc.Bookmarks, folderID),
	}
	doc.Bookmarks = append(doc.Bookmarks, bm)

	if err := Save(s.dataDir, doc); err != nil {
		return Bookmark{}, fmt.Errorf("bookmarks.Add: %w", err)
	}

	s.broadcaster.Broadcast(EventBookmarkChanged, map[string]any{}, notes.SessionIDFromContext(ctx))

	return bm, nil
}

// Remove drops the bookmark row matching id and persists. Unknown id
// returns ErrNotFound WITHOUT persisting.
func (s *Service) Remove(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	doc, err := Load(s.dataDir, s.registry, s.log)
	if err != nil {
		return fmt.Errorf("bookmarks.Remove: %w", err)
	}

	idx := indexOfBookmark(doc.Bookmarks, id)
	if idx == -1 {
		return fmt.Errorf("bookmarks.Remove(%s): %w", id, ErrNotFound)
	}

	removedFolderID := doc.Bookmarks[idx].FolderID
	doc.Bookmarks = append(doc.Bookmarks[:idx], doc.Bookmarks[idx+1:]...)
	// WR-02: close the Order gap left in the removed row's folder so
	// remaining siblings stay contiguous (0..n-1) instead of colliding
	// with the next Add's per-folder count.
	renumberFolder(doc.Bookmarks, removedFolderID)

	if err := Save(s.dataDir, doc); err != nil {
		return fmt.Errorf("bookmarks.Remove: %w", err)
	}

	s.broadcaster.Broadcast(EventBookmarkChanged, map[string]any{}, notes.SessionIDFromContext(ctx))

	return nil
}

// MoveToFolder sets the bookmark row's FolderID (nil moves it to top
// level) and persists. Unknown bookmark id returns ErrNotFound; a
// non-nil folderID that does not exist in the document returns
// ErrFolderNotFound. Neither error persists a change.
func (s *Service) MoveToFolder(ctx context.Context, id string, folderID *string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	doc, err := Load(s.dataDir, s.registry, s.log)
	if err != nil {
		return fmt.Errorf("bookmarks.MoveToFolder: %w", err)
	}

	idx := indexOfBookmark(doc.Bookmarks, id)
	if idx == -1 {
		return fmt.Errorf("bookmarks.MoveToFolder(%s): %w", id, ErrNotFound)
	}

	if folderID != nil && !folderExists(doc.Folders, *folderID) {
		return fmt.Errorf("bookmarks.MoveToFolder: folder %s: %w", *folderID, ErrFolderNotFound)
	}

	oldFolderID := doc.Bookmarks[idx].FolderID
	doc.Bookmarks[idx].FolderID = folderID
	// WR-02: renumber the source folder to close the gap left behind, and
	// (if the bookmark actually changed folders) the destination folder so
	// the moved row gets a contiguous per-folder Order rather than a stale
	// value carried over from its previous folder.
	renumberFolder(doc.Bookmarks, oldFolderID)
	if folderKey(oldFolderID) != folderKey(folderID) {
		renumberFolder(doc.Bookmarks, folderID)
	}

	if err := Save(s.dataDir, doc); err != nil {
		return fmt.Errorf("bookmarks.MoveToFolder: %w", err)
	}

	s.broadcaster.Broadcast(EventBookmarkChanged, map[string]any{}, notes.SessionIDFromContext(ctx))

	return nil
}

// CreateFolder appends a new Folder and persists it. name is trimmed;
// empty/whitespace-only names return ErrInvalidName WITHOUT persisting.
// No filesystem-legal-character validation is applied — these are
// virtual labels, not filesystem folders.
func (s *Service) CreateFolder(ctx context.Context, name string) (Folder, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return Folder{}, fmt.Errorf("bookmarks.CreateFolder: %w", ErrInvalidName)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	doc, err := Load(s.dataDir, s.registry, s.log)
	if err != nil {
		return Folder{}, fmt.Errorf("bookmarks.CreateFolder: %w", err)
	}

	f := Folder{ID: uuid.NewString(), Name: trimmed}
	doc.Folders = append(doc.Folders, f)

	if err := Save(s.dataDir, doc); err != nil {
		return Folder{}, fmt.Errorf("bookmarks.CreateFolder: %w", err)
	}

	s.broadcaster.Broadcast(EventBookmarkChanged, map[string]any{}, notes.SessionIDFromContext(ctx))

	return f, nil
}

// Reorder assigns Order = index for each id in orderedIDs, scoped to
// folderID (nil = top-level), and persists. orderedIDs must be EXACTLY
// the current membership of that folder scope — a missing id, an extra
// id, or a foreign id not currently in that scope is rejected wholesale
// with ErrNotFound and no write (T-JV1-01: do not trust client-supplied
// ids, same forged-id posture as T-27-01). A non-nil folderID that does
// not exist in the document returns ErrFolderNotFound (T-JV1-02).
func (s *Service) Reorder(ctx context.Context, folderID *string, orderedIDs []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	doc, err := Load(s.dataDir, s.registry, s.log)
	if err != nil {
		return fmt.Errorf("bookmarks.Reorder: %w", err)
	}

	if folderID != nil && !folderExists(doc.Folders, *folderID) {
		return fmt.Errorf("bookmarks.Reorder: folder %s: %w", *folderID, ErrFolderNotFound)
	}

	key := folderKey(folderID)
	currentIndex := make(map[string]int, len(doc.Bookmarks))
	for i, bm := range doc.Bookmarks {
		if folderKey(bm.FolderID) == key {
			currentIndex[bm.ID] = i
		}
	}

	if len(orderedIDs) != len(currentIndex) {
		return fmt.Errorf("bookmarks.Reorder: membership mismatch: %w", ErrNotFound)
	}
	seen := make(map[string]bool, len(orderedIDs))
	for _, id := range orderedIDs {
		if seen[id] {
			return fmt.Errorf("bookmarks.Reorder: duplicate id %s: %w", id, ErrNotFound)
		}
		seen[id] = true
		if _, ok := currentIndex[id]; !ok {
			return fmt.Errorf("bookmarks.Reorder: unknown id %s: %w", id, ErrNotFound)
		}
	}

	for order, id := range orderedIDs {
		doc.Bookmarks[currentIndex[id]].Order = order
	}

	if err := Save(s.dataDir, doc); err != nil {
		return fmt.Errorf("bookmarks.Reorder: %w", err)
	}

	s.broadcaster.Broadcast(EventBookmarkChanged, map[string]any{}, notes.SessionIDFromContext(ctx))

	return nil
}

func indexOfBookmark(bookmarks []Bookmark, id string) int {
	for i, bm := range bookmarks {
		if bm.ID == id {
			return i
		}
	}
	return -1
}

func folderExists(folders []Folder, id string) bool {
	for _, f := range folders {
		if f.ID == id {
			return true
		}
	}
	return false
}

// folderKey converts a *string FolderID into a comparable map/switch key —
// nil (top-level/ungrouped) and a concrete folder id are distinct keys.
func folderKey(id *string) string {
	if id == nil {
		return ""
	}
	return *id
}

// countInFolder returns how many bookmarks currently share folderID's
// scope (WR-02: Order is per-folder, not a global counter).
func countInFolder(bookmarks []Bookmark, folderID *string) int {
	key := folderKey(folderID)
	n := 0
	for _, bm := range bookmarks {
		if folderKey(bm.FolderID) == key {
			n++
		}
	}
	return n
}

// renumberFolder reassigns contiguous 0..n-1 Order values, in existing
// slice order, to every bookmark sharing folderID's scope. Called after
// Remove/MoveToFolder so sibling Order values never carry a gap or a
// stale value that could collide with a subsequent Add's countInFolder.
func renumberFolder(bookmarks []Bookmark, folderID *string) {
	key := folderKey(folderID)
	order := 0
	for i := range bookmarks {
		if folderKey(bookmarks[i].FolderID) == key {
			bookmarks[i].Order = order
			order++
		}
	}
}
