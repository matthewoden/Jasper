package api

import (
	"errors"
	"io/fs"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

func newError(code, message string) Error {
	return Error{Code: code, Message: message}
}

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
