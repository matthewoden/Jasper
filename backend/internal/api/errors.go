package api

import (
	"errors"
	"io/fs"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// newError constructs the api.Error wire shape (matches openapi.yaml
// Error schema: {code, message}).
//
// handlers.go inlines the per-route error mapping (404 vs 500) because each
// strict-server response type is distinct (e.g., GetNoteById404JSONResponse
// vs PutNoteById404JSONResponse) and a generic helper would have to return
// `any`. Keeping the constructor here so the wire shape lives in one place
// is cheap; the per-route translation lives at the call site.
func newError(code, message string) Error {
	return Error{Code: code, Message: message}
}

// mapServiceErrorToWire translates a domain error from notes.Service /
// fsstore primitives into a wire-format (code, message, ok) triple.
//
// The locked Plan 03-04 error mapping table:
//
//	notes.ErrNotFound          → not_found        (caller maps to 404)
//	fsstore.ErrCaseCollision   → case_collision   (caller maps to 409)
//	notes.ErrCaseCollision     → case_collision   (caller maps to 409)
//	fsstore.ErrFolderNotEmpty  → folder_not_empty (caller maps to 409)
//	fsstore.ErrParentNotFound  → parent_not_found (caller maps to 400)
//	fsstore.ErrCycle           → cycle            (caller maps to 400)
//	fsstore.ErrPathEscape /
//	fsstore.ErrAbsolutePath /
//	fsstore.ErrEmptyPath /
//	fsstore.ErrNotInRoot       → invalid_path     (caller maps to 400)
//	notes.ErrInvalidContent    → invalid_request  (caller maps to 400)
//
// The third return value (ok) signals whether err matched a known
// sentinel. When ok==false the caller MUST return a bare error so the
// strict-server runtime emits a generic 500 — the wrapped chain is
// logged via slog (T-03-04-01 voice rule: never leak internal paths
// or SQL state to the wire).
//
// notes.Service validation helpers (validateNoteTitle / validateFolderName)
// wrap their returned error chain with ErrInvalidContent so the API
// layer can map every validation failure to a typed 400 via the
// single errors.Is gate above — no structural string-matching fallback.
func mapServiceErrorToWire(err error) (code, message string, ok bool) {
	switch {
	case errors.Is(err, notes.ErrNotFound), errors.Is(err, fs.ErrNotExist):
		return "not_found", "note or folder does not exist", true
	case errors.Is(err, fsstore.ErrCaseCollision), errors.Is(err, notes.ErrCaseCollision):
		return "case_collision", "a note or folder with this name already exists", true
	case errors.Is(err, fsstore.ErrFolderNotEmpty):
		return "folder_not_empty", "folder is not empty — pass recursive=true to delete contents", true
	case errors.Is(err, fsstore.ErrParentNotFound):
		return "parent_not_found", "parent folder does not exist", true
	case errors.Is(err, fsstore.ErrCycle):
		return "cycle", "cannot move a folder into its own descendant", true
	case errors.Is(err, fsstore.ErrPathEscape),
		errors.Is(err, fsstore.ErrAbsolutePath),
		errors.Is(err, fsstore.ErrEmptyPath),
		errors.Is(err, fsstore.ErrNotInRoot):
		return "invalid_path", "path is not allowed", true
	case errors.Is(err, notes.ErrInvalidContent):
		return "invalid_request", "name contains characters that are not allowed", true
	}
	return "", "", false
}
