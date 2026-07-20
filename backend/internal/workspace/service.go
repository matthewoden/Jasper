package workspace

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Service is the workspace-preferences domain service. Every mutation
// follows a read-modify-write shape over the flat-file document:
// Load(dataDir, log) -> mutate ONLY the field being set -> Save(dataDir,
// doc) -> broadcast. Mirrors bookmarks.Service's shape
// (bookmarks/service.go), minus the notes.Registry dependency.
type Service struct {
	dataDir     string
	broadcaster notes.Broadcaster
	log         *slog.Logger

	// mu serializes every setter's Load -> mutate -> Save cycle. Without
	// it, two concurrent requests against the same shared workspace.json
	// can both Load the same pre-mutation document and have one Save
	// silently clobber the other's change (mirrors bookmarks WR-01).
	mu sync.Mutex
}

// New constructs the service. Passing nil for broadcaster substitutes a
// nopBroadcaster no-op, exactly like bookmarks.New. A nil log is replaced
// with slog.Default().
func New(dataDir string, broadcaster notes.Broadcaster, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	if broadcaster == nil {
		broadcaster = nopBroadcaster{}
	}
	return &Service{
		dataDir:     dataDir,
		broadcaster: broadcaster,
		log:         log,
	}
}

type nopBroadcaster struct{}

func (nopBroadcaster) Broadcast(_ string, _ any, _ string) {}

// SetNotesSort loads the existing doc, sets ONLY NotesSort, saves, and
// broadcasts. SearchSort is left untouched. Rejects a value outside the
// closed enum set with ErrInvalidSort WITHOUT touching disk.
func (s *Service) SetNotesSort(ctx context.Context, value string) (Workspace, error) {
	if !validNotesSort[value] {
		return Workspace{}, fmt.Errorf("workspace.SetNotesSort(%q): %w", value, ErrInvalidSort)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	doc, err := Load(s.dataDir, s.log)
	if err != nil {
		return Workspace{}, fmt.Errorf("workspace.SetNotesSort: %w", err)
	}

	doc.NotesSort = value

	if err := Save(s.dataDir, doc); err != nil {
		return Workspace{}, fmt.Errorf("workspace.SetNotesSort: %w", err)
	}

	s.broadcaster.Broadcast(EventWorkspaceChanged, map[string]any{}, notes.SessionIDFromContext(ctx))

	return doc, nil
}

// SetSearchSort loads the existing doc, sets ONLY SearchSort, saves, and
// broadcasts. NotesSort is left untouched. Rejects a value outside the
// closed enum set with ErrInvalidSort WITHOUT touching disk.
func (s *Service) SetSearchSort(ctx context.Context, value string) (Workspace, error) {
	if !validSearchSort[value] {
		return Workspace{}, fmt.Errorf("workspace.SetSearchSort(%q): %w", value, ErrInvalidSort)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	doc, err := Load(s.dataDir, s.log)
	if err != nil {
		return Workspace{}, fmt.Errorf("workspace.SetSearchSort: %w", err)
	}

	doc.SearchSort = value

	if err := Save(s.dataDir, doc); err != nil {
		return Workspace{}, fmt.Errorf("workspace.SetSearchSort: %w", err)
	}

	s.broadcaster.Broadcast(EventWorkspaceChanged, map[string]any{}, notes.SessionIDFromContext(ctx))

	return doc, nil
}
