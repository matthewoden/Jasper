package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// registryLister is the slice of the indexer that the boot-time registry
// hydrate needs. Narrow, so a test can drive the failure path without a
// database.
type registryLister interface {
	List(ctx context.Context) ([]notes.NoteSummary, error)
}

const (
	hydrateAttempts = 3
	hydrateBackoff  = 50 * time.Millisecond
)

// hydrateList reads the summaries the registry is built from, retrying a bounded
// number of times before giving up.
//
// Two failure classes arrive here. A momentary SQLite lock under parallel load
// clears on its own, so retrying rides it out — 50ms then 100ms, well inside the
// startup budget. A missing or corrupt table does not clear, so the attempts are
// capped and the error returned: the caller refuses to serve rather than come up
// with an empty registry, which to the user is indistinguishable from the vault
// having lost its contents (JASPER-9).
func hydrateList(ctx context.Context, lister registryLister, log *slog.Logger, attempts int, backoff time.Duration) ([]notes.NoteSummary, error) {
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		summaries, err := lister.List(ctx)
		if err == nil {
			if attempt > 1 {
				log.Info("registry hydrate: List succeeded on retry", "attempt", attempt)
			}
			return summaries, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
		if attempt < attempts {
			log.Warn("registry hydrate: List failed, retrying",
				"attempt", attempt, "attempts", attempts, "err", err)
			time.Sleep(backoff << (attempt - 1))
		}
	}
	return nil, fmt.Errorf("list notes after %d attempts: %w", attempts, lastErr)
}
