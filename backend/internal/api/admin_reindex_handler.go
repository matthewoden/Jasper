package api

import (
	"context"
	"errors"
	"time"

	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

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

// PostAdminReindex implements POST /api/v1/admin/reindex.
//
//nolint:revive // generated interface name
func (s *Server) PostAdminReindex(
	ctx context.Context,
	req PostAdminReindexRequestObject,
) (PostAdminReindexResponseObject, error) {
	if s.runner == nil {
		return PostAdminReindex503JSONResponse(
			newError("no_runner", "migration runner not available"),
		), nil
	}

	if !s.reindexBusy.TryLock() {
		return PostAdminReindex409JSONResponse(
			newError("reindex_in_progress", "another reindex is already running"),
		), nil
	}
	defer s.reindexBusy.Unlock()

	started := time.Now().UTC()

	mode := "full"
	if req.Body != nil && req.Body.Mode != nil {
		mode = string(*req.Body.Mode)
	}

	if mode != "full" && mode != "incremental" {
		return PostAdminReindex409JSONResponse(
			newError("invalid_mode", "mode must be 'full' or 'incremental'"),
		), nil
	}

	if s.broadcaster != nil {
		s.broadcaster.Broadcast(notes.EventReindexStarted, map[string]any{"mode": mode}, "")
	}

	notesIndexed := 0
	defer func() {
		if s.broadcaster != nil {
			s.broadcaster.Broadcast(notes.EventReindexComplete, map[string]any{
				"mode":          mode,
				"notes_indexed": notesIndexed,
			}, "")
		}
	}()

	switch mode {
	case "full":
		status, err := s.runner.RebuildAndReindex(ctx)
		if err != nil {
			if errors.Is(err, migrate.ErrUnrecoverable) {
				s.log.Error("PostAdminReindex: rebuild fired Path 3", "err", err)
				return PostAdminReindex503JSONResponse(
					newError("unrecoverable",
						"rebuild failed; database is in unrecoverable state — see logs"),
				), nil
			}
			s.log.Error("PostAdminReindex: rebuild failed", "err", err)
			return nil, errors.New("could not rebuild index")
		}

		s.hydrateRegistryFromIndex(ctx)
		notesIndexed = status.NotesIndexed
		n := notesIndexed
		return PostAdminReindex202JSONResponse{
			StartedAt:    started,
			NotesIndexed: &n,
		}, nil

	case "incremental":

		idx, ok := s.index.(*index.Indexer)
		if !ok || idx == nil {
			return PostAdminReindex503JSONResponse(
				newError("no_indexer", "indexer not available"),
			), nil
		}
		n, err := idx.Reconcile(ctx, index.ModeIncremental)
		if err != nil {
			s.log.Error("PostAdminReindex: incremental reconcile failed", "err", err)
			return nil, errors.New("could not run incremental reindex")
		}

		s.hydrateRegistryFromIndex(ctx)
		notesIndexed = n
		return PostAdminReindex202JSONResponse{
			StartedAt:    started,
			NotesIndexed: &n,
		}, nil

	default:

		return PostAdminReindex409JSONResponse(
			newError("invalid_mode", "mode must be 'full' or 'incremental'"),
		), nil
	}
}
