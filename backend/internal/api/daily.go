package api

import (
	"context"
	"errors"
	"regexp"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/markdown"
)

var dailyDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// GetDailyNote implements GET /api/v1/daily-notes/{date}.
//
// Get-or-create semantics are owned entirely by
// notes.Service.GetOrCreateDailyNote (file-FIRST write, index upsert,
// registry title index, note:created broadcast exactly once on create,
// zero broadcasts on get). This handler validates the date format, loads
// the configured template, and maps the Service result onto the wire.
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

	tmpl := ""
	if s.dataDir != "" {
		if cfg, err := config.Load(s.dataDir, s.log); err == nil {
			tmpl = cfg.DailyNotes.Template
		}
	}

	note, created, err := s.notes.GetOrCreateDailyNote(ctx, date, tmpl)
	if err != nil {
		s.log.Error("GetDailyNote: GetOrCreateDailyNote", "date", date, "err", err)
		return nil, errors.New("could not load daily note")
	}

	tagSlice := markdown.ExtractTags([]byte(note.Content))
	if tagSlice == nil {
		tagSlice = []string{}
	}
	detail := NoteDetail{
		Id:        openapi_types.UUID(note.ID),
		Path:      note.Path,
		Content:   note.Content,
		UpdatedAt: note.UpdatedAt,
		Tags:      &tagSlice,
	}
	if created {
		return GetDailyNote201JSONResponse(detail), nil
	}
	return GetDailyNote200JSONResponse(detail), nil
}
