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

// GetOrCreateDailyNote implements the get-or-create semantics for
// GET /api/v1/daily-notes/{date} entirely inside the domain service —
// no direct filesystem, index, or registry access from the API handler.
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
	relPath := "daily/" + date + ".md"

	rec, lookupErr := s.index.LookupByPath(ctx, relPath)
	switch {
	case lookupErr == nil:
		s.registry.AddRecord(rec.ID, rec.Path, strings.ToLower(date))
		note, getErr := s.Get(ctx, rec.ID)
		if getErr != nil {
			return Note{}, false, fmt.Errorf("notes.GetOrCreateDailyNote(%s): %w", date, getErr)
		}
		return note, false, nil
	case !errors.Is(lookupErr, ErrNotFound):
		return Note{}, false, fmt.Errorf("notes.GetOrCreateDailyNote(%s): lookup: %w", date, lookupErr)
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

	note, getErr := s.Get(ctx, summary.ID)
	if getErr != nil {
		return Note{}, false, fmt.Errorf("notes.GetOrCreateDailyNote(%s): post-create get: %w", date, getErr)
	}
	return note, true, nil
}
