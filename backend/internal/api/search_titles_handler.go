package api

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"
)

const recencyWindowSecs = 90 * 24 * 3600

// GetNotesSearchTitles implements GET /api/v1/notes/search-titles.
//
// Used by the wiki-link [[autocomplete]] extension as its data source.
//
// Parameters:
//   - q:     case-insensitive substring filter on title (default "")
//   - limit: max results (default 10, clamped to [1, 50])
//
// Results are ordered by recency (mtime DESC). proximity_score is null for all v1 results.
//
//nolint:revive // generated interface name
func (s *Server) GetNotesSearchTitles(
	ctx context.Context,
	req GetNotesSearchTitlesRequestObject,
) (GetNotesSearchTitlesResponseObject, error) {
	q := ""
	if req.Params.Q != nil {
		q = *req.Params.Q
	}
	limit := 10
	if req.Params.Limit != nil {
		limit = int(*req.Params.Limit)
	}

	if limit > 50 {
		limit = 50
	}
	if limit < 1 {
		limit = 1
	}

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
			ProximityScore: nil,
		})
	}
	return GetNotesSearchTitles200JSONResponse{Results: out}, nil
}

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

func folderOf(path string) string {
	dir := filepath.Dir(path)

	if dir == "." {
		return ""
	}
	return dir
}

func optString(s string) *string {
	if s == "" {
		return nil
	}

	clean := strings.ReplaceAll(s, `\`, "/")
	return &clean
}
