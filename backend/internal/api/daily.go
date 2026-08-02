package api

import (
	"context"
	"errors"
	"regexp"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

var dailyDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// GetDailyNote implements GET /api/v1/daily-notes/{date}.
//
// Read-only, and must stay that way: a get-or-create GET let any cross-origin
// <img> tag write into the vault, since the Origin guard skips safe methods.
//
//nolint:revive // generated interface name
func (s *Server) GetDailyNote(
	ctx context.Context,
	req GetDailyNoteRequestObject,
) (GetDailyNoteResponseObject, error) {
	date := req.Date

	if !dailyDateRe.MatchString(date) {
		return GetDailyNote400JSONResponse(newError("invalid_date", "Date must be in YYYY-MM-DD format.")), nil
	}

	if s.notes == nil {
		return nil, errors.New("GetDailyNote: server not configured with a notes service")
	}

	note, err := s.notes.GetDailyNote(ctx, date)
	if err != nil {
		if errors.Is(err, notes.ErrNotFound) {
			return GetDailyNote404JSONResponse(newError("not_found",
				"No daily note exists for this date.")), nil
		}
		s.log.Error("GetDailyNote: GetDailyNote", "date", date, "err", err)
		return nil, errors.New("could not load daily note")
	}

	return GetDailyNote200JSONResponse(dailyNoteDetail(note)), nil
}

// CreateDailyNote implements POST /api/v1/daily-notes/{date}.
// Idempotent: 201 on create, 200 when it already existed.
//
//nolint:revive // generated interface name
func (s *Server) CreateDailyNote(
	ctx context.Context,
	req CreateDailyNoteRequestObject,
) (CreateDailyNoteResponseObject, error) {
	date := req.Date

	if !dailyDateRe.MatchString(date) {
		return CreateDailyNote400JSONResponse(newError("invalid_date", "Date must be in YYYY-MM-DD format.")), nil
	}

	if s.notes == nil {
		return nil, errors.New("CreateDailyNote: server not configured with a notes service")
	}

	tmpl := ""
	if s.dataDir != "" {
		if cfg, err := config.Load(s.dataDir, s.log); err == nil {
			tmpl = cfg.DailyNotes.Template
		}
	}

	note, created, err := s.notes.GetOrCreateDailyNote(ctx, date, tmpl)
	if err != nil {
		s.log.Error("CreateDailyNote: GetOrCreateDailyNote", "date", date, "err", err)
		return nil, errors.New("could not create daily note")
	}

	detail := dailyNoteDetail(note)
	if created {
		return CreateDailyNote201JSONResponse(detail), nil
	}
	return CreateDailyNote200JSONResponse(detail), nil
}

func dailyNoteDetail(note notes.Note) NoteDetail {
	tagSlice := markdown.ExtractTags([]byte(note.Content))
	if tagSlice == nil {
		tagSlice = []string{}
	}
	return NoteDetail{
		Id:        openapi_types.UUID(note.ID),
		Path:      note.Path,
		Content:   note.Content,
		UpdatedAt: note.UpdatedAt,
		Tags:      &tagSlice,
	}
}
