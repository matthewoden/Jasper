package api

// files.go — GET /api/v1/files?path=... (UAT-3 R7 / Plan 07-32a).
//
// Generic file streamer for non-markdown files under <dataDir>/notes/. Path-
// traversal hardened with the same 5-rule pipeline as GetAttachment in
// attachments.go (RESEARCH §Thread 4 §Path Traversal Hardening — D-34,
// SECURITY-06). Refuses .md files (those are served via /notes/{id} which
// has the lookup-by-UUID + ETag model — Plan 07-31 INVESTIGATION
// "Why option (a) generic /files is preferred").
//
// `path` is bound from the `path` URL query parameter (req.Params.Path) per
// the OpenAPI contract. The query-parameter approach mirrors DELETE /folders
// and avoids OpenAPI 3.1's missing multi-segment-path wildcard syntax + the
// lack of chi `*` catch-all emission in oapi-codegen.

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

//nolint:revive // generated interface name
func (s *Server) GetFile(
	_ context.Context,
	req GetFileRequestObject,
) (GetFileResponseObject, error) {
	rawPath := req.Params.Path

	// Rule 1: reject `..` and absolute paths (POSIX `/` and Windows `\`) in
	// the input. Defense-in-depth before filepath.Join could re-anchor on a
	// leading separator.
	if strings.Contains(rawPath, "..") ||
		strings.HasPrefix(rawPath, "/") ||
		strings.HasPrefix(rawPath, `\`) {
		return GetFile400JSONResponse(newError("invalid_path",
			"path must not contain '..' or be absolute")), nil
	}

	// Rule 2: clean. An empty / "."/ "/" residue means the input was
	// effectively empty after Clean; refuse rather than serve the dir root.
	cleanRel := filepath.Clean(rawPath)
	if cleanRel == "." || cleanRel == "/" || cleanRel == "" {
		return GetFile400JSONResponse(newError("invalid_path",
			"invalid path after clean")), nil
	}

	// Rule 2b: refuse .md files (case-insensitive). Markdown bodies are
	// served via /notes/{id} which has lookup-by-UUID + ETag semantics.
	// Returning 404 here keeps the surface coherent: a generic file
	// streamer that says "this thing doesn't live here, use the other
	// endpoint" rather than leaking that the file exists.
	if strings.HasSuffix(strings.ToLower(cleanRel), ".md") {
		return GetFile404JSONResponse(newError("not_found",
			"markdown files are served via /notes/{id}")), nil
	}

	// Rule 3: compute the bounding directory (notesRoot for /files; same
	// formula as attachments.go GetAttachment line 193 except we anchor at
	// the vault root rather than a per-note attachments/ subdir).
	notesRoot := filepath.Join(s.dataDir, "notes")

	// Rule 4: prefix-check the cleaned final path stays within notesRoot.
	finalPath := filepath.Join(notesRoot, cleanRel)
	cleanFinal := filepath.Clean(finalPath)
	cleanRoot := filepath.Clean(notesRoot) + string(os.PathSeparator)
	if !strings.HasPrefix(cleanFinal, cleanRoot) {
		return GetFile400JSONResponse(newError("invalid_path",
			"path escapes notes directory")), nil
	}

	// Rule 5: os.Lstat (NOT Stat) to reject symlinks without following
	// them. Mirrors attachments.go GetAttachment lines 207–218.
	fi, lstatErr := os.Lstat(cleanFinal)
	if lstatErr != nil {
		if os.IsNotExist(lstatErr) {
			return GetFile404JSONResponse(newError("not_found",
				"file not found")), nil
		}
		s.log.Error("GetFile: Lstat", "path", cleanFinal, "err", lstatErr)
		return nil, errors.New("could not read file")
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return GetFile403JSONResponse(newError("symlink_rejected",
			"symlinked files are not served")), nil
	}
	if fi.IsDir() {
		return GetFile404JSONResponse(newError("not_found",
			"path is a directory")), nil
	}

	// Read file bytes — single-user self-host model; the 100MB upload cap
	// (D-29) bounds the typical file size. Pre-existing >100MB files are
	// the user's choice (T-32a-04 accepted).
	fileData, readErr := os.ReadFile(cleanFinal)
	if readErr != nil {
		s.log.Error("GetFile: ReadFile", "path", cleanFinal, "err", readErr)
		return nil, errors.New("could not read file")
	}

	return GetFile200ApplicationoctetStreamResponse{
		Body:          bytes.NewReader(fileData),
		ContentLength: int64(len(fileData)),
	}, nil
}
