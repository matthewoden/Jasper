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
		return PostAdminReindex202JSONResponse{
			StartedAt:    started,
			NotesIndexed: &n,
		}, nil

	default:
		return PostAdminReindex409JSONResponse(
			newError("invalid_mode", "mode must be 'full' or 'incremental'")), nil
	}
}
