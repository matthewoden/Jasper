package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// NoteIDMarker is recorded in schema_migrations once every note has been
// given an id. The walk is idempotent per file, so a partial run resumes on
// the next boot and a dropped marker table only costs a read-only pass.
const NoteIDMarker = "007_note_ids_complete"

// NoteIDReport is what a walk over notes/ found and did.
type NoteIDReport struct {
	Scanned int
	// Written lists the notes that were given an id, or would be on a dry run.
	Written []string
	// CRLF lists notes skipped because their frontmatter is CRLF.
	CRLF []string
	// Duplicates maps an id to every note carrying it when there is more
	// than one. The walk never resolves these; reconcile does, with the
	// index's knowledge of which path held the id first.
	Duplicates map[string][]string
}

// Changed reports whether a real run would write anything.
func (r NoteIDReport) Changed() bool { return len(r.Written) > 0 }

// InjectNoteIDs gives every note under notesDir that lacks a valid id one,
// changing nothing else in the file. With dryRun it only reports.
func InjectNoteIDs(ctx context.Context, notesDir string, dryRun bool, log *slog.Logger) (NoteIDReport, error) {
	report := NoteIDReport{Duplicates: map[string][]string{}}
	byID := map[string][]string{}
	notesDir, err := filepath.Abs(notesDir)
	if err != nil {
		return report, err
	}

	walkErr := index.WalkVault(ctx, notesDir, func(fm index.FileMeta) error {
		rel, path := fm.CanonicalRelPath, fm.AbsPath
		report.Scanned++

		content, readErr := os.ReadFile(path)
		if readErr != nil {
			log.Warn("note ids: read failed; skipping file", "path", rel, "err", readErr)
			return nil
		}

		if raw, found := markdown.ReadID(content); found {
			if id, perr := notes.ParseID(raw); perr == nil {
				byID[id.String()] = append(byID[id.String()], rel)
				return nil
			}
			log.Warn("note ids: malformed id; reassigning", "path", rel, "id", raw)
		}

		id := notes.NewID()
		if strings.ToLower(rel) == notes.ScratchpadRelPath {
			id = notes.ScratchpadID
		}
		updated, err := markdown.WithID(content, id.String())
		if errors.Is(err, markdown.ErrCRLFFrontmatter) {
			report.CRLF = append(report.CRLF, rel)
			log.Warn("note ids: CRLF frontmatter; not writing an id", "path", rel)
			return nil
		}
		if err != nil {
			return fmt.Errorf("note ids: %s: %w", rel, err)
		}
		report.Written = append(report.Written, rel)
		if dryRun {
			return nil
		}
		if err := doAtomicWrite(path, updated); err != nil {
			return fmt.Errorf("note ids: atomic write %s: %w", rel, err)
		}
		byID[id.String()] = append(byID[id.String()], rel)
		log.Info("note ids: wrote id", "path", rel, "id", id)
		return nil
	})
	if walkErr != nil {
		return report, walkErr
	}

	for id, paths := range byID {
		if len(paths) > 1 {
			sort.Strings(paths)
			report.Duplicates[id] = paths
		}
	}
	sort.Strings(report.Written)
	sort.Strings(report.CRLF)
	return report, nil
}

// InjectNoteIDsMigration runs InjectNoteIDs once per index and records the
// marker. It runs after the schema migrations and before reconcile, so the
// first reconcile on an upgraded vault already reads ids from disk.
func InjectNoteIDsMigration(ctx context.Context, writerDB *sql.DB, notesDir string, log *slog.Logger) error {
	var dummy string
	err := writerDB.QueryRowContext(ctx,
		`SELECT version FROM schema_migrations WHERE version = ?`, NoteIDMarker).Scan(&dummy)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("note ids migration: check marker: %w", err)
	}

	log.Info("note ids migration: starting walk", "dir", notesDir)
	report, err := InjectNoteIDs(ctx, notesDir, false, log)
	if err != nil {
		return err
	}
	if _, err := writerDB.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
		NoteIDMarker, time.Now().Unix(),
	); err != nil {
		return fmt.Errorf("note ids migration: record marker: %w", err)
	}
	log.Info("note ids migration: complete",
		"scanned", report.Scanned,
		"written", len(report.Written),
		"crlf_skipped", len(report.CRLF),
		"duplicate_ids", len(report.Duplicates))
	return nil
}
