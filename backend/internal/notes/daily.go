package notes

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/markdown"
)

// dailyFrontmatterPrefix mirrors the unexported markdown.frontmatterPrefix —
// every markdown.NewDailyNoteContent output begins with exactly these bytes.
const dailyFrontmatterPrefix = "---\ntags: []\n---\n\n"

// dailyScaffoldH1 mirrors the H1 line markdown.NewNoteContent(date) embeds
// (frontmatterPrefix + "# " + date + "\n\n"). CreateWithBodyAndTitle prepends
// its own NewNoteContent(displayTitle) scaffold, so the body passed to it
// must exclude this prefix — otherwise a daily note using the default
// template would end up with two frontmatter blocks / two H1s.
func dailyScaffoldH1(date string) string {
	return "# " + date + "\n\n"
}

// dailyRelPath is the on-disk location of a daily note. date is validated
// (YYYY-MM-DD) by the caller before either daily entry point is invoked.
func dailyRelPath(date string) string { return "daily/" + date + ".md" }

// GetDailyNote reads the daily note for date, returning ErrNotFound when it
// does not exist. Strictly read-only — it backs GET /api/v1/daily-notes/{date},
// which must not touch the filesystem.
//
// Like the get branch of GetOrCreateDailyNote, this (re)populates the
// registry with the date as title so [[date]] resolves across a restart or a
// registry eviction. That is an in-memory index write, not a vault write.
func (s *Service) GetDailyNote(ctx context.Context, date string) (Note, error) {
	rec, lookupErr := s.index.LookupByPath(ctx, dailyRelPath(date))
	if lookupErr != nil {
		if errors.Is(lookupErr, ErrNotFound) {
			return Note{}, ErrNotFound
		}
		return Note{}, fmt.Errorf("notes.GetDailyNote(%s): lookup: %w", date, lookupErr)
	}

	s.registry.AddRecord(rec.ID, rec.Path, strings.ToLower(date))
	note, getErr := s.Get(ctx, rec.ID)
	if getErr != nil {
		return Note{}, fmt.Errorf("notes.GetDailyNote(%s): %w", date, getErr)
	}
	return note, nil
}

// GetOrCreateDailyNote implements the get-or-create semantics for
// POST /api/v1/daily-notes/{date} entirely inside the domain service —
// no direct filesystem, index, or registry access from the API handler.
//
// This is reached only by POST. It used to back the GET as well, which made
// note creation a side effect of a safe method — see the note on
// GetDailyNote above.
//
// relPath is always "daily/<date>.md"; date is validated (YYYY-MM-DD) by
// the caller before this is invoked.
//
// Existing note (get branch): the registry is (re)populated with the date
// as title — via AddRecord — so [[date]] resolves even across a restart
// or a registry eviction. This is a read: no broadcast fires.
//
// Absent note (create branch): created via CreateWithBodyAndTitle, which
// owns the file-FIRST write, index upsert, title/FTS/backlink indexing,
// and the note:created broadcast (exactly once).
func (s *Service) GetOrCreateDailyNote(ctx context.Context, date, template string) (Note, bool, error) {
	note, getErr := s.GetDailyNote(ctx, date)
	switch {
	case getErr == nil:
		return note, false, nil
	case !errors.Is(getErr, ErrNotFound):
		return Note{}, false, fmt.Errorf("notes.GetOrCreateDailyNote(%s): %w", date, getErr)
	}

	if err := s.files.CreateDir("daily"); err != nil && !errors.Is(err, fsstore.ErrCaseCollision) {
		return Note{}, false, fmt.Errorf("notes.GetOrCreateDailyNote(%s): create daily folder: %w", date, err)
	}

	full := string(markdown.NewDailyNoteContent(date, template))
	body := strings.TrimPrefix(strings.TrimPrefix(full, dailyFrontmatterPrefix), dailyScaffoldH1(date))

	summary, err := s.CreateWithBodyAndTitle(ctx, "daily", date, body, date)
	if err != nil {
		return Note{}, false, fmt.Errorf("notes.GetOrCreateDailyNote(%s): %w", date, err)
	}

	created, err := s.Get(ctx, summary.ID)
	if err != nil {
		return Note{}, false, fmt.Errorf("notes.GetOrCreateDailyNote(%s): post-create get: %w", date, err)
	}
	return created, true, nil
}
