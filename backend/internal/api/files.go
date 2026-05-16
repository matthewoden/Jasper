package api

// files.go — GET + POST /api/v1/files?path=... (Plans 07-32a + 07-34).
//
// GetFile (Plan 07-32a, UAT-3 R7) — generic file streamer for non-markdown
// files under <dataDir>/notes/. Path-traversal hardened with the same 5-rule
// pipeline as GetAttachment in attachments.go (RESEARCH §Thread 4 §Path
// Traversal Hardening — D-34, SECURITY-06). Refuses .md files (those are
// served via /notes/{id} which has the lookup-by-UUID + ETag model — Plan
// 07-31 INVESTIGATION "Why option (a) generic /files is preferred").
//
// CreateFile (Plan 07-34, UAT-3 N2) — multipart upload for the sidebar
// tree's OS-file drop target. Lands the upload at <dataDir>/notes/<path>/
// <unique-filename>. Reuses generateUniqueFilename (Plan 07-06) for
// collision-safe naming. Refuses .md uploads (those go through POST
// /notes). Same 5-rule path-traversal pipeline as GetFile, plus a Lstat
// that ensures the target is a directory (NO auto-mkdir — the user
// creates folders via the existing tree UI before dropping). 100MB cap
// (D-29).
//
// `path` is bound from the `path` URL query parameter (req.Params.Path)
// for BOTH verbs per the OpenAPI contract. The query-parameter approach
// mirrors DELETE /folders and avoids OpenAPI 3.1's missing multi-segment-
// path wildcard syntax + the lack of chi `*` catch-all emission in
// oapi-codegen (see Plan 07-32a SUMMARY for the full rationale).

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
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

// CreateFile implements POST /api/v1/files?path=<targetDir> (Plan 07-34).
//
// Pipeline (mirrors GetFile + CreateAttachment patterns):
//
//  1. Path-traversal hardening on the TARGET DIRECTORY (req.Params.Path).
//     Rules 1–4 from GetFile are applied; the difference is that Rule 2
//     accepts the empty path (vault root) rather than rejecting it — POST
//     to "" lands at notes/ itself.
//  2. Lstat the cleaned target — must exist (NO auto-mkdir for safety),
//     must NOT be a symlink (403), must be a directory (400 otherwise).
//  3. Read multipart body's "file" part (mirrors CreateAttachment).
//  4. 100 MB cap via io.LimitReader+1 (D-29 / maxAttachmentBytes const
//     reused from attachments.go).
//  5. Sanitize the client-supplied filename via filepath.Base(filepath.
//     Clean(...)) — defense in depth against path components in the
//     uploaded filename.
//  6. Refuse .md uploads (case-insensitive). Markdown bodies must go
//     through POST /notes; this endpoint is for non-markdown files only.
//     Returns 400 with code "invalid_filename".
//  7. generateUniqueFilename (Plan 07-06) renames on collision:
//     photo.png → photo-1.png → photo-2.png up to 999.
//  8. fsstore.AtomicWrite (DATA-13) for the disk write.
//  9. http.DetectContentType for the response's content_type field.
//
//nolint:revive // generated interface name
func (s *Server) CreateFile(
	_ context.Context,
	req CreateFileRequestObject,
) (CreateFileResponseObject, error) {
	rawTargetDir := req.Params.Path

	// 1. Path-traversal hardening on the target dir.
	if strings.Contains(rawTargetDir, "..") ||
		strings.HasPrefix(rawTargetDir, "/") ||
		strings.HasPrefix(rawTargetDir, `\`) {
		return CreateFile400JSONResponse(newError("invalid_path",
			"path must not contain '..' or be absolute")), nil
	}

	// Clean. Unlike GetFile, "" / "." / "/" are accepted here — they
	// represent the vault root.
	cleanRel := filepath.Clean(rawTargetDir)
	if cleanRel == "." || cleanRel == "/" {
		cleanRel = ""
	}

	notesRoot := filepath.Join(s.dataDir, "notes")
	targetDir := filepath.Join(notesRoot, cleanRel)
	cleanTarget := filepath.Clean(targetDir)
	cleanNotesRoot := filepath.Clean(notesRoot)

	// Prefix check: target must equal notesRoot OR live under it.
	if cleanTarget != cleanNotesRoot &&
		!strings.HasPrefix(cleanTarget, cleanNotesRoot+string(os.PathSeparator)) {
		return CreateFile400JSONResponse(newError("invalid_path",
			"target dir escapes notes directory")), nil
	}

	// 2. Target dir must exist AND be a directory. NO auto-mkdir for safety
	// (T-34-06): the user creates folders via the existing tree UI before
	// dropping. This also avoids the case where a typo in the wire format
	// silently creates an empty directory.
	fi, lstatErr := os.Lstat(cleanTarget)
	if lstatErr != nil {
		if os.IsNotExist(lstatErr) {
			return CreateFile400JSONResponse(newError("invalid_path",
				"target dir does not exist")), nil
		}
		s.log.Error("CreateFile: Lstat", "path", cleanTarget, "err", lstatErr)
		return nil, errors.New("could not stat target dir")
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return CreateFile403JSONResponse(newError("symlink_rejected",
			"target dir is a symlink")), nil
	}
	if !fi.IsDir() {
		return CreateFile400JSONResponse(newError("invalid_path",
			"target is not a directory")), nil
	}

	// 3. Read multipart body — req.Body is *multipart.Reader (oapi-codegen
	// v2 multipart convention; CreateAttachment uses the same pattern).
	if req.Body == nil {
		return CreateFile400JSONResponse(newError("invalid_request",
			"missing multipart body")), nil
	}
	part, err := req.Body.NextPart()
	if err != nil {
		s.log.Error("CreateFile: NextPart", "err", err)
		return CreateFile400JSONResponse(newError("invalid_request",
			"missing multipart 'file' part")), nil
	}
	defer part.Close() //nolint:errcheck
	if part.FormName() != "file" {
		return CreateFile400JSONResponse(newError("invalid_request",
			"expected form field named 'file'")), nil
	}

	// 4. Cap at 100 MB (D-29 / maxAttachmentBytes). LimitReader+1 detects
	// overflow: if we read maxAttachmentBytes+1 bytes, the upload is too
	// large.
	capped := io.LimitReader(part, maxAttachmentBytes+1)
	data, readErr := io.ReadAll(capped)
	if readErr != nil {
		s.log.Error("CreateFile: io.ReadAll", "err", readErr)
		return nil, errors.New("read upload failed")
	}
	if int64(len(data)) > maxAttachmentBytes {
		return CreateFile413JSONResponse(newError("file_too_large",
			"Maximum upload size is 100 MB.")), nil
	}

	// 5. Sanitize the client-supplied filename (defense in depth).
	originalFilename := part.FileName()
	if originalFilename == "" {
		return CreateFile400JSONResponse(newError("invalid_request",
			"upload part missing filename")), nil
	}
	originalFilename = filepath.Base(filepath.Clean(originalFilename))
	if originalFilename == "." || originalFilename == "/" || originalFilename == "" {
		return CreateFile400JSONResponse(newError("invalid_request",
			"invalid upload filename")), nil
	}

	// 6. Refuse .md files (case-insensitive). Markdown bodies must be
	// created via POST /notes which has the path-canonicalization +
	// case-collision (DATA-12) semantics. Mirrors GetFile Rule 2b.
	if strings.HasSuffix(strings.ToLower(originalFilename), ".md") {
		return CreateFile400JSONResponse(newError("invalid_filename",
			"markdown files must be created via POST /notes")), nil
	}

	// 7. Collision-safe rename (Plan 07-06 helper).
	finalName := generateUniqueFilename(cleanTarget, originalFilename)
	absPath := filepath.Join(cleanTarget, finalName)

	// 8. Atomic write (DATA-13).
	if writeErr := fsstore.AtomicWrite(absPath, data); writeErr != nil {
		s.log.Error("CreateFile: AtomicWrite", "path", absPath, "err", writeErr)
		return nil, fmt.Errorf("write file: %w", writeErr)
	}

	// 9. MIME sniff for content_type (D-27 pattern).
	sniffEnd := 512
	if len(data) < sniffEnd {
		sniffEnd = len(data)
	}
	contentType := http.DetectContentType(data[:sniffEnd])

	// Build response path — relative under notes/, forward-slashes for
	// wire format regardless of OS.
	relPath := finalName
	if cleanRel != "" {
		relPath = filepath.ToSlash(filepath.Join(cleanRel, finalName))
	}

	return CreateFile201JSONResponse{
		Path:        relPath,
		Name:        finalName,
		SizeBytes:   int64(len(data)),
		ContentType: &contentType,
	}, nil
}

// DeleteFile + PostFileMove + ServeFile implementations (Plan 07-38, UAT-4 R7b/R7a).
// Stubs land in the RED commit so the strict-server interface compiles; the
// GREEN commit replaces them with real bodies.

//nolint:revive // generated interface name
func (s *Server) DeleteFile(
	_ context.Context,
	_ DeleteFileRequestObject,
) (DeleteFileResponseObject, error) {
	return nil, errors.New("DeleteFile not implemented yet (Plan 07-38 RED)")
}

//nolint:revive // generated interface name
func (s *Server) PostFileMove(
	_ context.Context,
	_ PostFileMoveRequestObject,
) (PostFileMoveResponseObject, error) {
	return nil, errors.New("PostFileMove not implemented yet (Plan 07-38 RED)")
}

// ServeFile is a manual http.HandlerFunc that bypasses the generated GetFile
// wrapper (which hard-codes Content-Type: application/octet-stream — wrong
// for SVG). Wired in app/lifecycle.go AFTER HandlerFromMux so chi's
// last-registration-wins promotes it over wrapper.GetFile. RED stub: returns
// 501; GREEN replaces with the real implementation.
func (s *Server) ServeFile(w http.ResponseWriter, _ *http.Request) {
	http.Error(w, "ServeFile not implemented yet (Plan 07-38 RED)", http.StatusNotImplemented)
}
