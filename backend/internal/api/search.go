package api

import (
	"context"
	"errors"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// maxTagFilters caps the number of ANDed tag filters accepted per request
// as a defensive DoS guard, mirroring internal/index.maxTagFilters.
const maxTagFilters = 8

// SearchNotes implements GET /api/v1/search.
//
// A short/empty q is not an error when tag params are present — bare
// `tag:name` queries must still return matches.
//
//nolint:revive // generated interface name
func (s *Server) SearchNotes(
	ctx context.Context,
	req SearchNotesRequestObject,
) (SearchNotesResponseObject, error) {
	q := req.Params.Q
	tags := []string{}
	if req.Params.Tag != nil {
		for _, t := range *req.Params.Tag {
			if t == "" {
				continue
			}
			tags = append(tags, t)
			if len(tags) >= maxTagFilters {
				break
			}
		}
	}
	limit := 50
	if req.Params.Limit != nil {
		limit = int(*req.Params.Limit)
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}

	sort := "relevance"
	if req.Params.Sort != nil {
		sort = string(*req.Params.Sort)
	}
	switch sort {
	case "relevance", "modified", "created":
		// valid
	default:
		return SearchNotes400JSONResponse(newError("invalid_query", "Invalid sort value.")), nil
	}

	if len(q) < 2 && len(tags) == 0 {
		return SearchNotes200JSONResponse{Results: []SearchResult{}}, nil
	}

	if s.index == nil {
		return SearchNotes200JSONResponse{Results: []SearchResult{}}, nil
	}

	hits, err := s.index.SearchFTS(ctx, q, tags, limit, sort)
	if err != nil {
		if errors.Is(err, notes.ErrFTSQuerySyntax) {
			return SearchNotes400JSONResponse(newError("invalid_query", "Invalid search query.")), nil
		}
		s.log.Error("SearchNotes: index error", "q", q, "tags", tags, "sort", sort, "err", err)
		return nil, errors.New("search failed")
	}

	if len(hits) > limit {
		hits = hits[:limit]
	}

	results := make([]SearchResult, 0, len(hits))
	for _, h := range hits {
		createdAt := h.CreatedAt
		results = append(results, SearchResult{
			Id:           h.ID,
			Title:        h.Title,
			Path:         h.Path,
			ExcerptHtml:  h.ExcerptHTML,
			MatchingTags: h.MatchingTags,
			Rank:         float32(h.Rank),
			ModifiedAt:   h.ModifiedAt,
			Created:      &createdAt,
		})
	}
	return SearchNotes200JSONResponse{Results: results}, nil
}
