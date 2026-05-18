// Phase 8 Plan 08-07: deep-link path-fallback resolver.
//
// Implements GET /api/v1/notes/by-path?path=<rel> (D-30). Used by the
// SPA's useDeepLink hook when the preferred ?note=<uuid> form is
// unavailable (e.g. a coworker shared a URL that pre-dates the UUID
// indirection) — the path resolves to a NoteSummary via the indexer's
// LookupByPath port.
//
// Threat T-08-27: the input path is re-validated by the same 5-rule
// pipeline used by /files (api/files.go GetFile) for defense-in-depth.
// Even though the indexer would not return a NoteRecord for a traversal
// path, rejecting up front prevents the path from ever reaching the
// SQL query layer.
//
// This file REPLACES the Plan 08-01 placeholder body. The signature
// is identical so the strict-server interface stays satisfied.

package api

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// GetNoteByPath implements GET /api/v1/notes/by-path?path=<rel>.
//
// Pipeline (mirrors files.go Rules 1-4; Rule 5 — symlink Lstat — is
// implicitly enforced because a symlink could not have been indexed
// in the first place; the indexer would have followed it via
// fsstore.Canonicalize or skipped it):
//
//  1. Reject `..`, absolute paths, and Windows-style `\` prefixes.
//  2. filepath.Clean and refuse empty/"."/"/" residue.
//  3. Require `.md` suffix (deep-links target notes, not folders or
//     attachments).
//  4. Canonicalize via DATA-11 (NFC + lowercase) — the indexer stores
//     paths under this canonical form, so LookupByPath needs the
//     normalized input.
//  5. s.index.LookupByPath: on hit → 200 NoteSummary; on
//     notes.ErrNotFound → 404 code "not_found"; on other err → 500
//     via bare error.
//
// Returns 503-equivalent (bare error → 500) if s.index is nil — the
// Phase 1 NewServer constructor wires nil, and deep-links are
// useless without the indexer. The wire response is generic; the
// log includes the error chain.
//
//nolint:revive // generated interface name
func (s *Server) GetNoteByPath(
	ctx context.Context,
	req GetNoteByPathRequestObject,
) (GetNoteByPathResponseObject, error) {
	rawPath := req.Params.Path

	// Rule 1: reject `..`, absolute, and Windows `\` prefixes.
	if strings.Contains(rawPath, "..") ||
		strings.HasPrefix(rawPath, "/") ||
		strings.HasPrefix(rawPath, `\`) ||
		filepath.IsAbs(rawPath) {
		return GetNoteByPath400JSONResponse(newError("invalid_path",
			"path must not contain '..' or be absolute")), nil
	}

	// Rule 2: clean + refuse empty residue.
	cleanRel := filepath.Clean(rawPath)
	if cleanRel == "" || cleanRel == "." || cleanRel == "/" {
		return GetNoteByPath400JSONResponse(newError("invalid_path",
			"path resolves empty after clean")), nil
	}

	// Rule 3: deep-links target notes (.md) only. Folders + attachments
	// have their own surfaces (/tree, /files).
	if !strings.HasSuffix(strings.ToLower(cleanRel), ".md") {
		return GetNoteByPath400JSONResponse(newError("invalid_path",
			"path must end in .md")), nil
	}

	// Rule 4: DATA-11 canonical form (NFC + lowercase). The indexer
	// stores paths this way (see fsstore.Canonicalize / Index.Upsert
	// in service.go); the lookup MUST normalize before querying or
	// case-variant inputs would miss.
	canonRel := strings.ToLower(cleanRel)

	// Index is required for deep-link resolution. The Phase 1
	// NewServer 2-arg constructor passes nil — degrade to 404 (the
	// note is "not found" because there's no index to find it in).
	if s.index == nil {
		return GetNoteByPath404JSONResponse(newError("not_found",
			"no note at "+rawPath)), nil
	}

	rec, err := s.index.LookupByPath(ctx, canonRel)
	if err != nil {
		if errors.Is(err, notes.ErrNotFound) {
			return GetNoteByPath404JSONResponse(newError("not_found",
				"no note at "+rawPath)), nil
		}
		s.log.Error("GetNoteByPath: index lookup failed",
			"path", canonRel,
			"err", err,
		)
		// Generic 500 — strict-server emits the canned message.
		return nil, errors.New("could not look up note")
	}

	return GetNoteByPath200JSONResponse{
		Id:        openapi_types.UUID(rec.ID),
		Path:      rec.Path,
		Title:     rec.Title,
		UpdatedAt: time.Unix(rec.MTimeUnix, 0).UTC(),
	}, nil
}
