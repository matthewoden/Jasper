package api

// attachments.go — POST /api/v1/attachments/{noteId} (CreateAttachment)
//                  GET  /api/v1/attachments/{noteId}/{filename} (GetAttachment)
//
// Plan 07-06: multipart upload + file streaming for Phase 7 attachment feature.
//
// Multipart strategy: oapi-codegen v2 generates CreateAttachmentRequestObject
// with Body *multipart.Reader — exactly the standard library multipart.Reader.
// NextPart() is therefore available directly; no raw http.HandlerFunc fallback
// is needed. The generated strictHandler calls r.MultipartReader() and places
// the result in request.Body before invoking this handler.
//
// Path traversal hardening on GET: 5-rule pipeline per RESEARCH.md §Thread 4
// §Path Traversal Hardening (D-34, SECURITY-06).

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

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// maxAttachmentBytes is the 100 MB upload cap (D-29 / T-7-15).
const maxAttachmentBytes int64 = 100 << 20 // 100 MB

// CreateAttachment implements POST /api/v1/attachments/{noteId} (ATTACH-01..04).
//
// Accepts multipart/form-data with a single field 'file'. Stores the file under
// <dataDir>/notes/<parent>/attachments/ per D-25. Auto-renames on collision
// (image.png → image-1.png). Enforces 100 MB cap (D-29). Returns
// AttachmentUploadResult with filename, path, content_type, category, is_image,
// size_bytes.
//
//nolint:revive // generated interface name
func (s *Server) CreateAttachment(
	ctx context.Context,
	req CreateAttachmentRequestObject,
) (CreateAttachmentResponseObject, error) {
	// Step 1: validate note exists and retrieve its path.
	note, err := s.lookupNoteByStringID(ctx, req.NoteId)
	if err != nil {
		return CreateAttachment404JSONResponse(newError("not_found", "note not found")), nil
	}

	// Step 2: read the uploaded file from the multipart body.
	// req.Body is *multipart.Reader (oapi-codegen v2 multipart convention).
	if req.Body == nil {
		return CreateAttachment404JSONResponse(newError("invalid_request", "missing multipart body")), nil
	}

	part, err := req.Body.NextPart()
	if err != nil {
		s.log.Error("CreateAttachment: read multipart part", "noteId", req.NoteId, "err", err)
		return CreateAttachment404JSONResponse(newError("invalid_request", "missing multipart 'file' part")), nil
	}
	defer part.Close() //nolint:errcheck

	if part.FormName() != "file" {
		return CreateAttachment404JSONResponse(newError("invalid_request", "expected form field named 'file'")), nil
	}

	// Read bytes with a hard cap. LimitReader+1 lets us detect overflow:
	// if we read maxAttachmentBytes+1 bytes, the upload is too large.
	capped := io.LimitReader(part, maxAttachmentBytes+1)
	data, readErr := io.ReadAll(capped)
	if readErr != nil {
		s.log.Error("CreateAttachment: io.ReadAll", "noteId", req.NoteId, "err", readErr)
		return nil, errors.New("read upload failed")
	}
	if int64(len(data)) > maxAttachmentBytes {
		return CreateAttachment413JSONResponse(newError("file_too_large", "Maximum upload size is 100 MB.")), nil
	}

	// Step 3: sanitize the client-supplied filename (defense in depth — T-7-16).
	originalFilename := part.FileName()
	if originalFilename == "" {
		return CreateAttachment404JSONResponse(newError("invalid_request", "upload part missing filename")), nil
	}
	// filepath.Base(filepath.Clean(...)) strips any path components the client sneaks in.
	originalFilename = filepath.Base(filepath.Clean(originalFilename))
	if originalFilename == "." || originalFilename == "/" || originalFilename == "" {
		return CreateAttachment404JSONResponse(newError("invalid_request", "invalid upload filename")), nil
	}

	// Step 4: compute target attachments directory per D-25.
	//   - Root-level note (path = "root.md"): attachDir = <dataDir>/notes/attachments/
	//   - Sub-folder note (path = "sub/bar.md"): attachDir = <dataDir>/notes/sub/attachments/
	notesRoot := filepath.Join(s.dataDir, "notes")
	noteParentDir := filepath.Dir(filepath.Join(notesRoot, note.Path))
	attachDir := filepath.Join(noteParentDir, "attachments")
	if mkErr := os.MkdirAll(attachDir, 0o755); mkErr != nil {
		s.log.Error("CreateAttachment: MkdirAll", "dir", attachDir, "err", mkErr)
		return nil, fmt.Errorf("create attachments dir: %w", mkErr)
	}

	// Step 5: generate unique filename, avoiding collisions (ATTACH-04).
	finalName := generateUniqueFilename(attachDir, originalFilename)
	absPath := filepath.Join(attachDir, finalName)

	// Step 6: atomic write (DATA-13).
	if writeErr := fsstore.AtomicWrite(absPath, data); writeErr != nil {
		s.log.Error("CreateAttachment: AtomicWrite", "path", absPath, "err", writeErr)
		return nil, fmt.Errorf("write attachment: %w", writeErr)
	}

	// Step 7: MIME sniff for content_type (D-27).
	sniffEnd := 512
	if len(data) < sniffEnd {
		sniffEnd = len(data)
	}
	contentType := http.DetectContentType(data[:sniffEnd])
	// Supplement: narrow application/octet-stream using file extension
	// for well-known types that DetectContentType misses (e.g. PDF).
	if contentType == "application/octet-stream" {
		switch strings.ToLower(filepath.Ext(finalName)) {
		case ".pdf":
			contentType = "application/pdf"
		case ".zip":
			contentType = "application/zip"
		case ".tar":
			contentType = "application/x-tar"
		case ".gz":
			contentType = "application/x-gzip"
		case ".mp4":
			contentType = "video/mp4"
		case ".mp3":
			contentType = "audio/mpeg"
		case ".wav":
			contentType = "audio/wav"
		}
	}
	category := mimeToCategory(contentType, filepath.Ext(finalName))
	isImage := strings.HasPrefix(contentType, "image/")

	return CreateAttachment200JSONResponse{
		Filename:    finalName,
		Path:        "attachments/" + finalName,
		ContentType: contentType,
		Category:    AttachmentUploadResultCategory(category),
		IsImage:     isImage,
		SizeBytes:   int64(len(data)),
	}, nil
}

// GetAttachment implements GET /api/v1/attachments/{noteId}/{filename} (ATTACH-05/06).
//
// Streams the attachment file with full path-traversal hardening (5-rule pipeline
// per RESEARCH.md §Thread 4 §Path Traversal Hardening — D-34, SECURITY-06).
//
// Note on Content-Type: oapi-codegen's GetAttachment200ApplicationoctetStreamResponse
// always sets Content-Type: application/octet-stream in VisitGetAttachmentResponse.
// The actual MIME type is not settable via the generated response struct; the frontend
// must sniff the type from the filename or re-request after knowing the category from
// the CreateAttachment response. This is a known v1 limitation.
//
//nolint:revive // generated interface name
func (s *Server) GetAttachment(
	ctx context.Context,
	req GetAttachmentRequestObject,
) (GetAttachmentResponseObject, error) {
	// Step 1: validate note exists.
	note, err := s.lookupNoteByStringID(ctx, req.NoteId)
	if err != nil {
		return GetAttachment404JSONResponse(newError("not_found", "note not found")), nil
	}

	filename := req.Filename

	// Rule 1: reject filenames containing path separators or parent-directory refs.
	if strings.ContainsAny(filename, `/\`) || strings.Contains(filename, "..") {
		return GetAttachment400JSONResponse(newError("invalid_filename",
			"filename must not contain path separators or '..'")), nil
	}

	// Rule 2: extract base name only — defense in depth against any edge cases.
	filename = filepath.Base(filepath.Clean(filename))
	if filename == "." || filename == "/" || filename == "" {
		return GetAttachment400JSONResponse(newError("invalid_filename", "invalid filename after clean")), nil
	}

	// Rule 3: compute attachments directory (same formula as CreateAttachment).
	notesRoot := filepath.Join(s.dataDir, "notes")
	noteParentDir := filepath.Dir(filepath.Join(notesRoot, note.Path))
	attachDir := filepath.Join(noteParentDir, "attachments")

	// Rule 4: prefix-check the final path to ensure it cannot escape attachDir.
	finalPath := filepath.Join(attachDir, filename)
	cleanFinal := filepath.Clean(finalPath)
	cleanAttach := filepath.Clean(attachDir) + string(os.PathSeparator)
	if !strings.HasPrefix(cleanFinal, cleanAttach) {
		return GetAttachment400JSONResponse(newError("invalid_path",
			"filename escapes attachments directory")), nil
	}

	// Rule 5: use os.Lstat (NOT Stat) to reject symlinks without following them.
	fi, lstatErr := os.Lstat(cleanFinal)
	if lstatErr != nil {
		if os.IsNotExist(lstatErr) {
			return GetAttachment404JSONResponse(newError("not_found", "attachment not found")), nil
		}
		s.log.Error("GetAttachment: Lstat", "path", cleanFinal, "err", lstatErr)
		return nil, errors.New("could not read attachment")
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return GetAttachment403JSONResponse(newError("symlink_rejected",
			"symlinked attachments are not served")), nil
	}

	// Read file bytes.
	fileData, readErr := os.ReadFile(cleanFinal)
	if readErr != nil {
		s.log.Error("GetAttachment: ReadFile", "path", cleanFinal, "err", readErr)
		return nil, errors.New("could not read attachment")
	}

	return GetAttachment200ApplicationoctetStreamResponse{
		Body:          bytes.NewReader(fileData),
		ContentLength: int64(len(fileData)),
	}, nil
}

// lookupNoteByStringID parses the string noteID as a UUID and returns the
// matching NoteSummary from the index. Returns an error when the index is nil,
// the string is not a valid UUID, or no note with that ID is indexed.
//
// This reuses the O(n) List()-based lookup pattern from backlinks_handler.go.
// A dedicated LookupByID on the Index interface is a future improvement.
func (s *Server) lookupNoteByStringID(ctx context.Context, noteID string) (notes.NoteSummary, error) {
	if s.index == nil {
		return notes.NoteSummary{}, errors.New("no index")
	}

	id, err := uuid.Parse(noteID)
	if err != nil {
		return notes.NoteSummary{}, fmt.Errorf("invalid note id: %w", err)
	}

	summaries, listErr := s.index.List(ctx)
	if listErr != nil {
		return notes.NoteSummary{}, fmt.Errorf("list notes: %w", listErr)
	}

	for _, sm := range summaries {
		if sm.ID == id {
			return sm, nil
		}
	}
	return notes.NoteSummary{}, notes.ErrNotFound
}

// generateUniqueFilename returns a filename that does not exist in dir.
// Collision avoidance: image.png → image-1.png → image-2.png (ATTACH-04).
func generateUniqueFilename(dir, filename string) string {
	ext := filepath.Ext(filename)
	base := strings.TrimSuffix(filename, ext)

	// First: try the original name.
	if _, err := os.Stat(filepath.Join(dir, filename)); os.IsNotExist(err) {
		return filename
	}

	// Collision: try suffixes -1, -2, ... up to 999.
	for i := 1; i < 1000; i++ {
		candidate := fmt.Sprintf("%s-%d%s", base, i, ext)
		if _, err := os.Stat(filepath.Join(dir, candidate)); os.IsNotExist(err) {
			return candidate
		}
	}

	// Safety bound — should never be reached in practice.
	return fmt.Sprintf("%s-%d%s", base, 999, ext)
}

// mimeToCategory maps a MIME content type to the AttachmentUploadResult category
// enum (D-27): image | pdf | video | audio | archive | other.
func mimeToCategory(mimeType, _ string) string {
	switch {
	case strings.HasPrefix(mimeType, "image/"):
		return "image"
	case strings.HasPrefix(mimeType, "video/"):
		return "video"
	case strings.HasPrefix(mimeType, "audio/"):
		return "audio"
	case mimeType == "application/pdf":
		return "pdf"
	case mimeType == "application/zip",
		mimeType == "application/x-tar",
		mimeType == "application/x-gzip",
		strings.Contains(mimeType, "compressed"):
		return "archive"
	default:
		return "other"
	}
}
