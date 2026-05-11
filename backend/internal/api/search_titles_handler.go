package api

// search_titles_handler.go — Plan 06-11 Task 1: GetNotesSearchTitles handler.
//
// Replaces the GetNotesSearchTitles stub in handlers_phase6_stubs.go.
//
// Ranking: results are ordered by mtime DESC (recency). The index's SearchTitles
// returns rows already ordered by mtime_unix DESC. The handler converts each row's
// mtime into a recency_score in [0.0, 1.0]:
//
//	recency_score = max(0, 1 - (now - mtime) / windowSeconds)
//
// where windowSeconds = 90 days. Very recent notes score near 1.0; notes older
// than 90 days score 0.0. This is "D-40 implementer's call" — the window and
// formula can be tuned without a schema change.
//
// proximity_score is null for all v1 results (no source folder context provided).

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"
)

// recencyWindowSecs is the time window (in seconds) over which recency_score
// falls from 1.0 to 0.0. 90 days expressed in seconds.
const recencyWindowSecs = 90 * 24 * 3600

// GetNotesSearchTitles implements GET /api/v1/notes/search-titles (LINKS-06 / D-13).
//
// Used by the wiki-link [[autocomplete]] extension (Plan 06-10) as its data source.
//
// Parameters:
//   - q:     case-insensitive substring filter on title (default "")
//   - limit: max results (default 10, clamped to [1, 50])
//
// Results are ordered by recency (mtime DESC) — the index ensures this.
// proximity_score is null for all v1 results.
//
//nolint:revive // generated interface name
func (s *Server) GetNotesSearchTitles(
	ctx context.Context,
	req GetNotesSearchTitlesRequestObject,
) (GetNotesSearchTitlesResponseObject, error) {
	// Extract + validate parameters.
	q := ""
	if req.Params.Q != nil {
		q = *req.Params.Q
	}
	limit := 10
	if req.Params.Limit != nil {
		limit = int(*req.Params.Limit)
	}
	// Clamp limit per ST5.
	if limit > 50 {
		limit = 50
	}
	if limit < 1 {
		limit = 1
	}

	// Fast-path: nil index → empty results (Phase 1 compatibility).
	if s.index == nil {
		return GetNotesSearchTitles200JSONResponse{Results: []NoteSearchResult{}}, nil
	}

	results, err := s.index.SearchTitles(ctx, q, limit)
	if err != nil {
		s.log.Error("GetNotesSearchTitles: index error", "q", q, "limit", limit, "err", err)
		return nil, errors.New("search failed")
	}

	now := time.Now().Unix()
	out := make([]NoteSearchResult, 0, len(results))
	for _, r := range results {
		recency := computeRecencyScore(now, r.MtimeUnix)
		folder := folderOf(r.Path)
		out = append(out, NoteSearchResult{
			Id:             openapi_types.UUID(r.ID),
			Title:          r.Title,
			Folder:         optString(folder),
			RecencyScore:   recency,
			ProximityScore: nil, // v1: null (D-40 implementer's call — no source folder context)
		})
	}
	return GetNotesSearchTitles200JSONResponse{Results: out}, nil
}

// computeRecencyScore converts a Unix mtime to a [0.0, 1.0] recency score.
// Score is 1.0 for a note modified right now, 0.0 for notes ≥ 90 days old.
func computeRecencyScore(nowUnix, mtimeUnix int64) float32 {
	age := nowUnix - mtimeUnix
	if age <= 0 {
		return 1.0
	}
	if age >= recencyWindowSecs {
		return 0.0
	}
	return float32(1.0 - float64(age)/recencyWindowSecs)
}

// folderOf returns the containing folder path (relative, without trailing slash)
// for a note path, or empty string for vault-root notes.
// "notes/foo/bar.md" → "notes/foo"
// "foo.md" → ""
func folderOf(path string) string {
	dir := filepath.Dir(path)
	// filepath.Dir("foo.md") returns "." — normalize to ""
	if dir == "." {
		return ""
	}
	return dir
}

// optString converts a string to *string, returning nil for empty strings.
// Used for the Folder field (null for vault-root notes per the OpenAPI schema).
func optString(s string) *string {
	if s == "" {
		return nil
	}
	// Normalize path separators to forward slash for JSON consistency.
	clean := strings.ReplaceAll(s, `\`, "/")
	return &clean
}
