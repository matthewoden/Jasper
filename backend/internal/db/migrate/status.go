package migrate

import (
	"context"
	"sync"
)

// State enumerates the four migration runner states. The string values
// MUST match the openapi.yaml MigrationStatus.state enum verbatim — the
// api package's GetAdminStatus handler casts directly from migrate.State
// to api.MigrationStatusState.
type State string

const (
	// StateOK — schema is current; no action required.
	StateOK State = "ok"
	// StateRolledBack — Path 1 fired (a migration failed; backup
	// restored atomically). The app keeps running on the prior schema.
	// UX-03 banner is rendered while in this state.
	StateRolledBack State = "rolled_back"
	// StateRebuilding — Path 2 in progress (admin/reindex triggered a
	// drop-and-rebuild). UI shows the ReindexProgress overlay.
	StateRebuilding State = "rebuilding"
	// StateUnrecoverable — Path 3 fired (Path 1 restore itself failed,
	// or Path 2 also failed, or disk-full preflight aborted). The
	// composition root refuses to start the HTTP listener; a static
	// page is served instead.
	StateUnrecoverable State = "unrecoverable"
)

// Status is the snapshot returned by StatusProvider.Status. The struct
// shape mirrors the openapi.yaml MigrationStatus body; the api package
// translates between Status and api.MigrationStatus in admin_status.go.
type Status struct {
	State           State
	FailedMigration string // "" unless State == StateRolledBack
	LogsPath        string // absolute log file path (set when state in {rolled_back, unrecoverable})
	NotesIndexed    int    // count from `SELECT COUNT(*) FROM notes`; 0 if the table doesn't exist yet
}

// StatusProvider is consumed by api.Server (admin_status.go). The
// Runner implements StatusProvider directly via its embedded
// statusStore; tests substitute any other implementation that returns
// a fixed Status.
type StatusProvider interface {
	Status(ctx context.Context) Status
}

type statusStore struct {
	mu  sync.RWMutex
	cur Status
}

// Status returns a snapshot of the current state. Cheap: a struct copy
// under a read lock. Safe for concurrent callers.
func (s *statusStore) Status(_ context.Context) Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur
}

func (s *statusStore) set(next Status) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cur = next
}
