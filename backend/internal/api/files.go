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
)

//nolint:revive // generated interface name
func (s *Server) GetFile(
	_ context.Context,
	req GetFileRequestObject,
) (GetFileResponseObject, error) {
	rawPath := req.Params.Path

	if strings.Contains(rawPath, "..") ||
		strings.HasPrefix(rawPath, "/") ||
		strings.HasPrefix(rawPath, `\`) {
		return GetFile400JSONResponse(newError("invalid_path",
			"path must not contain '..' or be absolute")), nil
	}

	cleanRel := filepath.Clean(rawPath)
	if cleanRel == "." || cleanRel == "/" || cleanRel == "" {
		return GetFile400JSONResponse(newError("invalid_path",
			"invalid path after clean")), nil
	}

	if strings.HasSuffix(strings.ToLower(cleanRel), ".md") {
		return GetFile404JSONResponse(newError("not_found",
			"markdown files are served via /notes/{id}")), nil
	}

	notesRoot := filepath.Join(s.dataDir, "notes")

	finalPath := filepath.Join(notesRoot, cleanRel)
	cleanFinal := filepath.Clean(finalPath)
	cleanRoot := filepath.Clean(notesRoot) + string(os.PathSeparator)
	if !strings.HasPrefix(cleanFinal, cleanRoot) {
		return GetFile400JSONResponse(newError("invalid_path",
			"path escapes notes directory")), nil
	}

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
	targetDir := filepath.Join(notesRoot, cleanRel)
	cleanTarget := filepath.Clean(targetDir)
	cleanNotesRoot := filepath.Clean(notesRoot)

	if cleanTarget != cleanNotesRoot &&
		!strings.HasPrefix(cleanTarget, cleanNotesRoot+string(os.PathSeparator)) {
		return CreateFile400JSONResponse(newError("invalid_path",
			"target dir escapes notes directory")), nil
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

	notesRoot := filepath.Join(s.dataDir, "notes")
	finalPath := filepath.Join(notesRoot, cleanRel)
	cleanFinal := filepath.Clean(finalPath)
	cleanRoot := filepath.Clean(notesRoot) + string(os.PathSeparator)
	if !strings.HasPrefix(cleanFinal, cleanRoot) {
		return fileResolveResult{status: 400, errCode: "invalid_path", errMsg: "path escapes notes directory"}
	}

	fi, lstatErr := os.Lstat(cleanFinal)
	if lstatErr != nil {
		if os.IsNotExist(lstatErr) {
			return fileResolveResult{status: 404, errCode: "not_found", errMsg: "file not found", notFound: true}
		}
		return fileResolveResult{status: 500, errCode: "io_error", errMsg: "could not read file"}
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return fileResolveResult{status: 403, errCode: "symlink_rejected", errMsg: "symlinked files are not served"}
	}
	return fileResolveResult{abs: cleanFinal, fi: fi, ok: true}
}

// DeleteFile implements DELETE /api/v1/files?path=... (Plan 07-38 R7b).
// Mirrors GetFile's pipeline; refuses .md (those are notes); refuses
// directories (those are folders).
//
//nolint:revive // generated interface name
func (s *Server) DeleteFile(
	_ context.Context,
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
	return DeleteFile204Response{}, nil
}

// PostFileMove implements POST /api/v1/files/move (Plan 07-38 R7b).
// Both src_path and dst_path go through the 5-rule pipeline. Refuses .md
// (those go through POST /notes/{id}/move which has the SQLite-side
// path-canon update). Refuses overwrite (409 if dst exists).
//
//nolint:revive // generated interface name
func (s *Server) PostFileMove(
	_ context.Context,
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
	dstAbs := filepath.Clean(filepath.Join(notesRoot, dstClean))
	cleanRoot := filepath.Clean(notesRoot) + string(os.PathSeparator)
	if !strings.HasPrefix(dstAbs, cleanRoot) {
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
