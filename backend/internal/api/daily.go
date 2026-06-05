package api

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

var dailyDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// GetDailyNote implements GET /api/v1/daily-notes/{date} (DAILY-01..03 / D-32).
//
// Get-or-create semantics:
//  1. Validate date regex (T-7-12); reject with 400 + code='invalid_date' on mismatch.
//  2. Compute relPath = "daily/" + date + ".md".
//  3. If the note already exists in the index: read content from disk, return 200.
//  4. Otherwise: mkdir notes/daily/ (idempotent), build content via
//     markdown.NewDailyNoteContent, fsstore.AtomicWrite, index.Upsert, return 201.
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

	relPath := "daily/" + date + ".md"

	if s.index != nil {
		rec, err := s.index.LookupByPath(ctx, relPath)
		if err == nil {
			if s.notes != nil {
				s.notes.Registry().Add(rec.ID, rec.Path)
			}

			detail, derr := s.readDailyNoteDetail(ctx, rec, date)
			if derr != nil {
				s.log.Error("GetDailyNote: build detail (existing)", "path", relPath, "err", derr)
				return nil, errors.New("could not load daily note")
			}
			return GetDailyNote200JSONResponse(detail), nil
		}
		if !errors.Is(err, notes.ErrNotFound) {
			s.log.Warn("GetDailyNote: LookupByPath unexpected error; proceeding to create branch",
				"path", relPath, "err", err)
		}
	}

	if s.dataDir == "" {
		return nil, errors.New("GetDailyNote: server not configured with a data directory")
	}

	notesRoot := filepath.Join(s.dataDir, "notes")
	dailyDir := filepath.Join(notesRoot, "daily")

	if err := os.MkdirAll(dailyDir, 0o755); err != nil {
		s.log.Error("GetDailyNote: mkdir daily", "err", err)
		return nil, fmt.Errorf("create daily folder: %w", err)
	}

	tmpl := ""
	if cfg, err := config.Load(s.dataDir, s.log); err == nil {
		tmpl = cfg.DailyNotes.Template
	}
	content := markdown.NewDailyNoteContent(date, tmpl)

	absPath := filepath.Join(dailyDir, date+".md")
	if err := fsstore.AtomicWrite(absPath, content); err != nil {
		s.log.Error("GetDailyNote: atomic write", "path", absPath, "err", err)
		return nil, fmt.Errorf("write daily note: %w", err)
	}

	id := uuid.New()
	now := time.Now().UTC()
	rec := notes.NoteRecord{
		ID:            id,
		Path:          relPath,
		Title:         date,
		MTimeUnix:     now.Unix(),
		SizeBytes:     int64(len(content)),
		Checksum:      "",
		UpdatedAtUnix: now.Unix(),
	}
	if s.index != nil {
		if err := s.index.Upsert(ctx, rec); err != nil {
			s.log.Warn("GetDailyNote: index upsert failed (file safe; reconcile will heal)",
				"path", relPath, "err", err)
		} else {
			if sErr := s.index.SyncTags(ctx, id, []string{}); sErr != nil {
				s.log.Warn("GetDailyNote: SyncTags failed (non-fatal)", "err", sErr)
			}
		}
	}

	if s.notes != nil {
		s.notes.Registry().Add(id, relPath)
	}

	detail := NoteDetail{
		Id:        openapi_types.UUID(id),
		Path:      relPath,
		Content:   string(content),
		UpdatedAt: now,
		Tags:      &[]string{},
	}
	return GetDailyNote201JSONResponse(detail), nil
}

func (s *Server) readDailyNoteDetail(_ context.Context, rec notes.NoteRecord, _ string) (NoteDetail, error) {
	absPath := filepath.Join(s.dataDir, "notes", rec.Path)
	data, err := os.ReadFile(absPath)
	if err != nil {
		return NoteDetail{}, fmt.Errorf("readDailyNoteDetail: read %q: %w", absPath, err)
	}

	tagSlice := markdown.ExtractTags(data)
	if tagSlice == nil {
		tagSlice = []string{}
	}
	return NoteDetail{
		Id:        openapi_types.UUID(rec.ID),
		Path:      rec.Path,
		Content:   string(data),
		UpdatedAt: time.Unix(rec.MTimeUnix, 0).UTC(),
		Tags:      &tagSlice,
	}, nil
}
