package api

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
	"github.com/matthewoden/jasper/backend/internal/notes"
)

//nolint:revive // generated interface name
func (s *Server) GetFile(
	_ context.Context,
	req GetFileRequestObject,
) (GetFileResponseObject, error) {
	res := s.resolveFileUnderNotes(req.Params.Path)
	if !res.ok {
		if res.isMd {
			return GetFile404JSONResponse(newError("not_found",
				"markdown files are served via /notes/{id}")), nil
		}
		switch res.status {
		case 400:
			return GetFile400JSONResponse(newError(res.errCode, res.errMsg)), nil
		case 403:
			return GetFile403JSONResponse(newError(res.errCode, res.errMsg)), nil
		case 404:
			return GetFile404JSONResponse(newError(res.errCode, res.errMsg)), nil
		default:
			s.log.Error("GetFile: resolve", "path", req.Params.Path, "code", res.errCode)
			return nil, errors.New("could not read file")
		}
	}
	if res.fi.IsDir() {
		return GetFile404JSONResponse(newError("not_found",
			"path is a directory")), nil
	}

	fileData, readErr := os.ReadFile(res.abs)
	if readErr != nil {
		s.log.Error("GetFile: ReadFile", "path", res.abs, "err", readErr)
		return nil, errors.New("could not read file")
	}

	return GetFile200ApplicationoctetStreamResponse{
		Body:          bytes.NewReader(fileData),
		ContentLength: int64(len(fileData)),
	}, nil
}

// CreateFile implements POST /api/v1/files?path=<targetDir>.
//
// Pipeline:
//
//  1. Path-traversal hardening on the TARGET DIRECTORY (req.Params.Path).
//     Rules 1–4 from GetFile; empty path (vault root) is accepted here.
//  2. Lstat the cleaned target — must exist (NO auto-mkdir for safety),
//     must NOT be a symlink (403), must be a directory (400 otherwise).
//  3. Read multipart body's "file" part.
//  4. 100 MB cap via io.LimitReader+1 (shared maxAttachmentBytes const).
//  5. Sanitize the client-supplied filename via filepath.Base(filepath.Clean(...)).
//  6. Refuse .md uploads (case-insensitive). Markdown must go through POST /notes.
//     Returns 400 with code "invalid_filename".
//  7. generateUniqueFilename renames on collision:
//     photo.png → photo-1.png → photo-2.png up to 999.
//  8. fsstore.AtomicWrite for the disk write.
//  9. http.DetectContentType for the response's content_type field.
//
//nolint:revive // generated interface name
func (s *Server) CreateFile(
	ctx context.Context,
	req CreateFileRequestObject,
) (CreateFileResponseObject, error) {
	rawTargetDir := req.Params.Path

	if strings.Contains(rawTargetDir, "..") ||
		strings.HasPrefix(rawTargetDir, "/") ||
		strings.HasPrefix(rawTargetDir, `\`) {
		return CreateFile400JSONResponse(newError("invalid_path",
			"path must not contain '..' or be absolute")), nil
	}

	cleanRel := filepath.Clean(rawTargetDir)
	if cleanRel == "." || cleanRel == "/" {
		cleanRel = ""
	}

	notesRoot := filepath.Join(s.dataDir, "notes")
	cleanTarget := filepath.Clean(notesRoot)
	if cleanRel != "" {
		resolved, containErr := s.containedUnderNotes(cleanRel)
		if containErr != nil {
			return CreateFile400JSONResponse(newError("invalid_path",
				"target dir escapes notes directory")), nil
		}
		cleanTarget = resolved
	}

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

	if strings.HasSuffix(strings.ToLower(originalFilename), ".md") {
		return CreateFile400JSONResponse(newError("invalid_filename",
			"markdown files must be created via POST /notes")), nil
	}

	finalName := generateUniqueFilename(cleanTarget, originalFilename)
	absPath := filepath.Join(cleanTarget, finalName)

	if writeErr := fsstore.AtomicWrite(absPath, data); writeErr != nil {
		s.log.Error("CreateFile: AtomicWrite", "path", absPath, "err", writeErr)
		return nil, fmt.Errorf("write file: %w", writeErr)
	}

	sniffEnd := 512
	if len(data) < sniffEnd {
		sniffEnd = len(data)
	}
	contentType := http.DetectContentType(data[:sniffEnd])

	relPath := finalName
	if cleanRel != "" {
		relPath = filepath.ToSlash(filepath.Join(cleanRel, finalName))
	}

	if s.broadcaster != nil {
		s.broadcaster.Broadcast(notes.EventFileCreated, map[string]any{
			"path": relPath,
			"name": finalName,
		}, notes.SessionIDFromContext(ctx))
	}

	return CreateFile201JSONResponse{
		Path:        relPath,
		Name:        finalName,
		SizeBytes:   int64(len(data)),
		ContentType: &contentType,
	}, nil
}

type fileResolveResult struct {
	abs      string
	fi       os.FileInfo
	ok       bool
	status   int
	errCode  string
	errMsg   string
	isMd     bool
	notFound bool
}

func (s *Server) notesRoot() string { return filepath.Join(s.dataDir, "notes") }

// containedUnderNotes guarantees a vault-relative directory path resolves
// inside notes/ even when an ancestor component is a symlink. Use
// fsstore.ResolveContained for paths whose leaf is a file — it also reports
// the leaf's FileInfo and rejects a symlinked leaf.
func (s *Server) containedUnderNotes(rel string) (string, error) {
	return fsstore.ContainedPath(s.notesRoot(), rel)
}

func (s *Server) resolveFileUnderNotes(rawPath string) fileResolveResult {
	if strings.Contains(rawPath, "..") ||
		strings.HasPrefix(rawPath, "/") ||
		strings.HasPrefix(rawPath, `\`) {
		return fileResolveResult{status: 400, errCode: "invalid_path", errMsg: "path must not contain '..' or be absolute"}
	}
	cleanRel := filepath.Clean(rawPath)
	if cleanRel == "." || cleanRel == "/" || cleanRel == "" {
		return fileResolveResult{status: 400, errCode: "invalid_path", errMsg: "invalid path after clean"}
	}
	if strings.HasSuffix(strings.ToLower(cleanRel), ".md") {
		return fileResolveResult{status: 400, errCode: "invalid_path", errMsg: "markdown files are managed via /notes/{id}", isMd: true}
	}

	abs, fi, err := fsstore.ResolveContained(s.notesRoot(), cleanRel)
	switch {
	case err == nil:
		return fileResolveResult{abs: abs, fi: fi, ok: true}
	case errors.Is(err, fsstore.ErrSymlinkLeaf):
		return fileResolveResult{status: 403, errCode: "symlink_rejected", errMsg: "symlinked files are not served"}
	case os.IsNotExist(err):
		return fileResolveResult{status: 404, errCode: "not_found", errMsg: "file not found", notFound: true}
	case errors.Is(err, fsstore.ErrNotInRoot), errors.Is(err, fsstore.ErrPathEscape),
		errors.Is(err, fsstore.ErrAbsolutePath), errors.Is(err, fsstore.ErrEmptyPath):
		return fileResolveResult{status: 400, errCode: "invalid_path", errMsg: "path escapes notes directory"}
	default:
		return fileResolveResult{status: 500, errCode: "io_error", errMsg: "could not read file"}
	}
}

// DeleteFile implements DELETE /api/v1/files?path=...
// Mirrors GetFile's pipeline; refuses .md (those are notes); refuses
// directories (those are folders).
//
//nolint:revive // generated interface name
func (s *Server) DeleteFile(
	ctx context.Context,
	req DeleteFileRequestObject,
) (DeleteFileResponseObject, error) {
	res := s.resolveFileUnderNotes(req.Params.Path)
	if !res.ok {
		switch res.status {
		case 400:
			return DeleteFile400JSONResponse(newError(res.errCode, res.errMsg)), nil
		case 403:
			return DeleteFile403JSONResponse(newError(res.errCode, res.errMsg)), nil
		case 404:
			return DeleteFile404JSONResponse(newError(res.errCode, res.errMsg)), nil
		default:
			s.log.Error("DeleteFile: resolve", "path", req.Params.Path, "code", res.errCode)
			return nil, errors.New("could not delete file")
		}
	}
	if res.fi.IsDir() {
		return DeleteFile400JSONResponse(newError("invalid_path",
			"path is a directory (use DELETE /folders)")), nil
	}
	if err := os.Remove(res.abs); err != nil {
		s.log.Error("DeleteFile: os.Remove", "path", res.abs, "err", err)
		return nil, errors.New("could not delete file")
	}

	if s.broadcaster != nil {
		notesRoot := filepath.Join(s.dataDir, "notes")
		relPath, relErr := filepath.Rel(notesRoot, res.abs)
		if relErr != nil {
			relPath = filepath.Clean(req.Params.Path)
		}
		s.broadcaster.Broadcast(notes.EventFileDeleted, map[string]any{
			"path": filepath.ToSlash(relPath),
		}, notes.SessionIDFromContext(ctx))
	}

	return DeleteFile204Response{}, nil
}

// PostFileMove implements POST /api/v1/files/move.
// Both src_path and dst_path go through the 5-rule pipeline. Refuses .md
// (those go through POST /notes/{id}/move which has the SQLite-side
// path-canon update). Refuses overwrite (409 if dst exists).
//
//nolint:revive // generated interface name
func (s *Server) PostFileMove(
	ctx context.Context,
	req PostFileMoveRequestObject,
) (PostFileMoveResponseObject, error) {
	if req.Body == nil {
		return PostFileMove400JSONResponse(newError("invalid_request", "request body required")), nil
	}
	if req.Body.SrcPath == "" || req.Body.DstPath == "" {
		return PostFileMove400JSONResponse(newError("invalid_request", "src_path and dst_path are required")), nil
	}

	srcRes := s.resolveFileUnderNotes(req.Body.SrcPath)

	if !srcRes.ok && (srcRes.status == 400 || srcRes.status == 403) {
		switch srcRes.status {
		case 400:
			return PostFileMove400JSONResponse(newError(srcRes.errCode, srcRes.errMsg)), nil
		case 403:
			return PostFileMove403JSONResponse(newError(srcRes.errCode, srcRes.errMsg)), nil
		}
	}
	if !srcRes.ok && !srcRes.notFound && srcRes.status != 400 && srcRes.status != 403 {
		return nil, errors.New("could not stat src file")
	}

	dstRaw := req.Body.DstPath
	if strings.Contains(dstRaw, "..") ||
		strings.HasPrefix(dstRaw, "/") ||
		strings.HasPrefix(dstRaw, `\`) {
		return PostFileMove400JSONResponse(newError("invalid_path",
			"dst path must not contain '..' or be absolute")), nil
	}
	dstClean := filepath.Clean(dstRaw)
	if dstClean == "." || dstClean == "/" || dstClean == "" {
		return PostFileMove400JSONResponse(newError("invalid_path", "invalid dst path")), nil
	}
	if strings.HasSuffix(strings.ToLower(dstClean), ".md") {
		return PostFileMove400JSONResponse(newError("invalid_path",
			"markdown files are managed via /notes/{id}")), nil
	}
	notesRoot := filepath.Join(s.dataDir, "notes")
	dstAbs, dstErr := s.containedUnderNotes(dstClean)
	if dstErr != nil {
		return PostFileMove400JSONResponse(newError("invalid_path",
			"dst escapes notes directory")), nil
	}

	if srcRes.notFound {
		srcAbsForCmp := filepath.Clean(filepath.Join(notesRoot, filepath.Clean(req.Body.SrcPath)))
		dstFi, dstErr := os.Lstat(dstAbs)
		if dstErr == nil && !dstFi.IsDir() &&
			filepath.Base(srcAbsForCmp) == filepath.Base(dstAbs) {
			s.log.Info("PostFileMove: idempotent repeat dispatch (src missing, dst exists with same basename)",
				"src", srcAbsForCmp, "dst", dstAbs)
			finalName := filepath.Base(dstAbs)
			finalPath := filepath.ToSlash(dstClean)
			return PostFileMove200JSONResponse{
				Path: finalPath,
				Name: finalName,
			}, nil
		}
		s.log.Warn("PostFileMove: src not found",
			"src", srcAbsForCmp, "dst", dstAbs, "dstLstatErr", dstErr)
		return PostFileMove404JSONResponse(newError(srcRes.errCode, srcRes.errMsg)), nil
	}

	if srcRes.fi.IsDir() {
		return PostFileMove400JSONResponse(newError("invalid_path",
			"src is a directory (use POST /folders/move)")), nil
	}

	if _, err := os.Lstat(dstAbs); err == nil {
		return PostFileMove409JSONResponse(newError("already_exists",
			"destination already exists")), nil
	} else if !os.IsNotExist(err) {
		s.log.Error("PostFileMove: Lstat dst", "path", dstAbs, "err", err)
		return nil, errors.New("could not stat dst file")
	}

	parent := filepath.Dir(dstAbs)
	if pi, perr := os.Lstat(parent); perr != nil {
		if os.IsNotExist(perr) {
			return PostFileMove400JSONResponse(newError("invalid_path",
				"dst parent directory does not exist")), nil
		}
		s.log.Error("PostFileMove: Lstat parent", "path", parent, "err", perr)
		return nil, errors.New("could not stat dst parent")
	} else if !pi.IsDir() {
		return PostFileMove400JSONResponse(newError("invalid_path",
			"dst parent is not a directory")), nil
	}

	if err := os.Rename(srcRes.abs, dstAbs); err != nil {
		s.log.Error("PostFileMove: os.Rename", "src", srcRes.abs, "dst", dstAbs, "err", err)
		return nil, errors.New("could not move file")
	}

	finalName := filepath.Base(dstAbs)
	finalPath := filepath.ToSlash(dstClean)

	if s.broadcaster != nil {
		s.broadcaster.Broadcast(notes.EventFileMoved, map[string]any{
			"old_path": filepath.ToSlash(filepath.Clean(req.Body.SrcPath)),
			"new_path": finalPath,
		}, notes.SessionIDFromContext(ctx))
	}

	return PostFileMove200JSONResponse{
		Path: finalPath,
		Name: finalName,
	}, nil
}

// ServeFile is a manual http.HandlerFunc that bypasses the generated
// GetFile wrapper (which hard-codes Content-Type: application/octet-stream
// — wrong for SVG, which browsers refuse to render in <img> without
// image/svg+xml). Wired in app/lifecycle.go AFTER HandlerFromMux so chi's
// last-registration-wins promotes it over wrapper.GetFile.
//
// Same 5-rule path-traversal pipeline as the strict GetFile handler. The
// Content-Type is computed via http.DetectContentType(first512) with an
// extension-based override for .svg (DetectContentType returns
// "text/xml; charset=utf-8" for SVG, which browsers refuse for <img>).
func (s *Server) ServeFile(w http.ResponseWriter, r *http.Request) {
	rawPath := r.URL.Query().Get("path")

	res := s.resolveFileUnderNotes(rawPath)
	if !res.ok {
		status := res.status
		code := res.errCode
		msg := res.errMsg
		if res.isMd {
			status = 404
			code = "not_found"
			msg = "markdown files are served via /notes/{id}"
		}
		s.writeJSONError(w, status, code, msg)
		return
	}
	if res.fi.IsDir() {
		s.writeJSONError(w, 404, "not_found", "path is a directory")
		return
	}

	data, readErr := os.ReadFile(res.abs)
	if readErr != nil {
		s.log.Error("ServeFile: ReadFile", "path", res.abs, "err", readErr)
		s.writeJSONError(w, 500, "io_error", "could not read file")
		return
	}

	sniffEnd := 512
	if len(data) < sniffEnd {
		sniffEnd = len(data)
	}
	ct := http.DetectContentType(data[:sniffEnd])
	if strings.HasSuffix(strings.ToLower(res.abs), ".svg") {
		ct = "image/svg+xml"
	}

	setRawFileSecurityHeaders(w.Header())
	w.Header().Set("Content-Disposition", contentDisposition(ct, filepath.Base(res.abs)))
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(data); err != nil {
		s.log.Error("ServeFile: write", "path", res.abs, "err", err)
	}
}

func (s *Server) writeJSONError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body := fmt.Sprintf(`{"code":%q,"message":%q}`, code, message)
	if _, err := w.Write([]byte(body)); err != nil {
		s.log.Error("writeJSONError: write", "err", err)
	}
}
