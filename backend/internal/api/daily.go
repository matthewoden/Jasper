package api

// daily.go — GET /api/v1/daily-notes/{date} handler (DAILY-01..03 / D-32).
//
// Get-or-create semantics:
//   - date regex validated first (T-7-12: path injection defence)
//   - existing daily/YYYY-MM-DD.md → 200 + NoteDetail
//   - missing → write from template + scaffold → index upsert → 201 + NoteDetail

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

// dailyDateRe accepts only YYYY-MM-DD (T-7-12: path injection guard).
// No leading/trailing characters permitted.
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

	// Step 1: validate date format (strict regex — path injection defence T-7-12).
	// Any date string that does not match ^\d{4}-\d{2}-\d{2}$ is rejected before
	// it touches the filesystem (no path join, no os.Stat, nothing).
	if !dailyDateRe.MatchString(date) {
		return GetDailyNote400JSONResponse(newError("invalid_date", "Date must be in YYYY-MM-DD format.")), nil
	}

	relPath := "daily/" + date + ".md"

	// Step 2: existence check via the index. nopIndex.LookupByPath always returns
	// ErrNotFound so tests without a real indexer always take the create branch.
	if s.index != nil {
		rec, err := s.index.LookupByPath(ctx, relPath)
		if err == nil {
			// Found — read content from disk and return 200.
			detail, derr := s.readDailyNoteDetail(ctx, rec, date)
			if derr != nil {
				s.log.Error("GetDailyNote: build detail (existing)", "path", relPath, "err", derr)
				return nil, errors.New("could not load daily note")
			}
			return GetDailyNote200JSONResponse(detail), nil
		}
		if !errors.Is(err, notes.ErrNotFound) {
			// Unexpected index error — treat as missing and try to create.
			s.log.Warn("GetDailyNote: LookupByPath unexpected error; proceeding to create branch",
				"path", relPath, "err", err)
		}
	}

	// Step 3: create branch.
	//
	// Notes root: <dataDir>/notes. If dataDir is empty (legacy NewServer call in
	// tests), we cannot write — surface a generic error.
	if s.dataDir == "" {
		return nil, errors.New("GetDailyNote: server not configured with a data directory")
	}

	notesRoot := filepath.Join(s.dataDir, "notes")
	dailyDir := filepath.Join(notesRoot, "daily")

	// 3a. Idempotent mkdir (T-7-14: concurrent callers both succeed here).
	if err := os.MkdirAll(dailyDir, 0o755); err != nil {
		s.log.Error("GetDailyNote: mkdir daily", "err", err)
		return nil, fmt.Errorf("create daily folder: %w", err)
	}

	// 3b. Load template from config (defaults to "# {{date}}\n\n" per DESIGN.md §11).
	tmpl := ""
	if cfg, err := config.Load(s.dataDir, s.log); err == nil {
		tmpl = cfg.DailyNotes.Template
	}
	content := markdown.NewDailyNoteContent(date, tmpl)

	// 3c. Atomic write (T-7-14: last-write-wins; both writes are byte-identical
	// for the same date+template, so the result is always correct).
	absPath := filepath.Join(dailyDir, date+".md")
	if err := fsstore.AtomicWrite(absPath, content); err != nil {
		s.log.Error("GetDailyNote: atomic write", "path", absPath, "err", err)
		return nil, fmt.Errorf("write daily note: %w", err)
	}

	// 3d. Index the new note.
	id := uuid.New()
	now := time.Now().UTC()
	rec := notes.NoteRecord{
		ID:            id,
		Path:          relPath,
		Title:         date, // date string is the title for daily notes
		MTimeUnix:     now.Unix(),
		SizeBytes:     int64(len(content)),
		Checksum:      "",
		UpdatedAtUnix: now.Unix(),
	}
	if s.index != nil {
		if err := s.index.Upsert(ctx, rec); err != nil {
			// Non-fatal per file-FIRST contract: file is on disk; next Reconcile heals.
			s.log.Warn("GetDailyNote: index upsert failed (file safe; reconcile will heal)",
				"path", relPath, "err", err)
		} else {
			// Sync empty tags (frontmatter scaffold has tags: []).
			if sErr := s.index.SyncTags(ctx, id, []string{}); sErr != nil {
				s.log.Warn("GetDailyNote: SyncTags failed (non-fatal)", "err", sErr)
			}
		}
	}

	// 3e. Return 201 with NoteDetail.
	detail := NoteDetail{
		Id:        openapi_types.UUID(id),
		Path:      relPath,
		Content:   string(content),
		UpdatedAt: now,
		Tags:      &[]string{},
	}
	return GetDailyNote201JSONResponse(detail), nil
}

// readDailyNoteDetail reads the content of an existing daily note from disk
// and assembles a NoteDetail for the 200 response.
func (s *Server) readDailyNoteDetail(_ context.Context, rec notes.NoteRecord, _ string) (NoteDetail, error) {
	absPath := filepath.Join(s.dataDir, "notes", rec.Path)
	data, err := os.ReadFile(absPath)
	if err != nil {
		return NoteDetail{}, fmt.Errorf("readDailyNoteDetail: read %q: %w", absPath, err)
	}
	tags := &[]string{}
	return NoteDetail{
		Id:        openapi_types.UUID(rec.ID),
		Path:      rec.Path,
		Content:   string(data),
		UpdatedAt: time.Unix(rec.MTimeUnix, 0).UTC(),
		Tags:      tags,
	}, nil
}
