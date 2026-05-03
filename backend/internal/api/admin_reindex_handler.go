package api

import (
	"context"
	"errors"
	"time"

	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/index"
)

// Server.reindexBusy is the per-Server mutex preventing concurrent
// /admin/reindex calls (declared on the Server struct in handlers.go).
// In production there is exactly one Server per process so this is
// effectively process-level; per-Server scoping lets tests run in
// parallel without spurious 409s.
//
// The mutex is held for the entire RebuildAndReindex / Reconcile
// call. Combined with sqlite.Pair.Writer.SetMaxOpenConns(1), this
// ensures a Service.Update cannot interleave with the rebuild's DROP
// (T-02-04b-08 mitigation).

// hydrateRegistryFromIndex re-hydrates the in-memory Registry from the
// post-rebuild SQLite notes table. Mirrors lifecycle.go:249-257 — same
// idempotent pattern, same warning-on-List-failure fallback.
//
// Without this call, /admin/reindex (mode=full or mode=incremental)
// leaves the Registry holding pre-rebuild UUIDs; any UUID minted by
// reconcileFull / reconcileIncremental — including any UUID for an
// externally-created file the rebuild discovers — is unreachable via
// Service.Get (404) until the server restarts. Gap 6a from
// 03-HUMAN-UAT.md, diagnosed in
// .planning/debug/scratchpad-vanishes-self-move.md (Resolution).
//
// Concurrency contract: the caller (PostAdminReindex) holds
// s.reindexBusy.Lock() across the entire rebuild. This helper runs
// inside that critical section, AFTER RebuildAndReindex / Reconcile
// succeed and BEFORE the JSON 202 response is returned, so a client
// receiving the 202 is guaranteed the Registry is consistent. The
// Registry has its own write-lock around Hydrate (registry.go:97);
// notes.Service.Get takes a Registry read-lock, so concurrent reads
// serialize correctly against this write. T-03-10-01 mitigation.
//
// Failure path: if List itself fails (transient SQLite error), we log
// and return WITHOUT touching the Registry. The pre-rebuild Registry
// state is preserved. The user can re-issue /admin/reindex; the next
// startup will re-hydrate from the canonical lifecycle path either way.
func (s *Server) hydrateRegistryFromIndex(ctx context.Context) {
	if s.notes == nil || s.index == nil {
		return
	}
	idx, ok := s.index.(*index.Indexer)
	if !ok || idx == nil {
		return
	}
	summaries, err := idx.List(ctx)
	if err != nil {
		s.log.Warn("admin/reindex: registry hydrate List failed (proceeding)",
			"err", err)
		return
	}
	s.notes.Registry().Hydrate(summaries)
	s.log.Info("admin/reindex: registry hydrated", "count", len(summaries))
}

// PostAdminReindex implements POST /api/v1/admin/reindex (DATA-10).
//
// Body: {mode: "full" | "incremental"} — "full" defaults if omitted.
//
//   - mode="full"  → s.runner.RebuildAndReindex (Path 2: drop, re-run
//     migrations, full re-index walk).
//   - mode="incremental" → s.index.Reconcile(ModeIncremental)
//     (cheap mtime-only delta — DATA-09 partial). W-1 fix: this mode
//     is now wired through; it no longer 503s on a valid enum value.
//
// Concurrency: reindexBusy.TryLock returns 409 with code
// "reindex_in_progress" if another reindex is already running.
//
// Error mapping:
//
//   - nil runner (Phase 1 NewServer compat) → 503 "no_runner".
//   - nil index for incremental → 503 "no_indexer".
//   - mode not in {"full","incremental"} → 409 "invalid_mode".
//   - runner returns ErrUnrecoverable → 503 "unrecoverable".
//   - any other runner / index error → bare 500 with a generic
//     message (T-02-04b-02 — never leak SQL or absolute paths).
//
//nolint:revive // generated interface name
func (s *Server) PostAdminReindex(
	ctx context.Context,
	req PostAdminReindexRequestObject,
) (PostAdminReindexResponseObject, error) {
	if s.runner == nil {
		return PostAdminReindex503JSONResponse(
			newError("no_runner", "migration runner not available")), nil
	}

	// Try-lock: if another reindex is in flight, return 409 immediately.
	if !s.reindexBusy.TryLock() {
		return PostAdminReindex409JSONResponse(
			newError("reindex_in_progress", "another reindex is already running")), nil
	}
	defer s.reindexBusy.Unlock()

	started := time.Now().UTC()

	// Default mode = "full" (per openapi.yaml ReindexRequest.mode).
	mode := "full"
	if req.Body != nil && req.Body.Mode != nil {
		mode = string(*req.Body.Mode)
	}

	switch mode {
	case "full":
		status, err := s.runner.RebuildAndReindex(ctx)
		if err != nil {
			if errors.Is(err, migrate.ErrUnrecoverable) {
				s.log.Error("PostAdminReindex: rebuild fired Path 3", "err", err)
				return PostAdminReindex503JSONResponse(
					newError("unrecoverable",
						"rebuild failed; database is in unrecoverable state — see logs")), nil
			}
			s.log.Error("PostAdminReindex: rebuild failed", "err", err)
			return nil, errors.New("could not rebuild index")
		}
		// Plan 03-10 Gap 6a fix: rebuild dropped+rebuilt the SQLite notes
		// table with freshly-minted UUIDs; re-hydrate the in-memory
		// Registry so Service.Get / GET /notes/{id} can resolve them
		// before the 202 response goes out. Mirrors the canonical
		// pattern at lifecycle.go:249-257.
		s.hydrateRegistryFromIndex(ctx)
		n := status.NotesIndexed
		return PostAdminReindex202JSONResponse{
			StartedAt:    started,
			NotesIndexed: &n,
		}, nil

	case "incremental":
		// W-1: incremental dispatches to Indexer.Reconcile(ModeIncremental).
		// We need the *Indexer concrete type for Reconcile (it's not on
		// the notes.Index port — Reconcile is the indexer's lifecycle
		// API, not a per-row CRUD). Type-assert.
		idx, ok := s.index.(*index.Indexer)
		if !ok || idx == nil {
			return PostAdminReindex503JSONResponse(
				newError("no_indexer", "indexer not available")), nil
		}
		n, err := idx.Reconcile(ctx, index.ModeIncremental)
		if err != nil {
			s.log.Error("PostAdminReindex: incremental reconcile failed", "err", err)
			return nil, errors.New("could not run incremental reindex")
		}
		// Plan 03-10 Gap 6a fix: incremental reconcile may have minted
		// fresh UUIDs for newly-discovered files; re-hydrate the
		// in-memory Registry so any new UUID is reachable via
		// Service.Get before the 202 response goes out.
		s.hydrateRegistryFromIndex(ctx)
		return PostAdminReindex202JSONResponse{
			StartedAt:    started,
			NotesIndexed: &n,
		}, nil

	default:
		return PostAdminReindex409JSONResponse(
			newError("invalid_mode", "mode must be 'full' or 'incremental'")), nil
	}
}
